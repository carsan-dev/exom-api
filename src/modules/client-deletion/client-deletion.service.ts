import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClientDeletion, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import * as admin from 'firebase-admin';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';

@Injectable()
export class DeletionIdentityService {
  credentialLifetimeMs(): number {
    // Firebase custom tokens can recreate the UID until their one-hour expiry.
    return 3600000;
  }

  async isAbsent(uid: string): Promise<boolean> {
    if (!admin.apps.length) throw new Error('IDENTITY_UNAVAILABLE');
    try {
      await admin.auth().getUser(uid);
      return false;
    } catch (error: unknown) {
      if (this.isMissing(error)) return true;
      throw error;
    }
  }

  async remove(uid: string): Promise<void> {
    if (!admin.apps.length) throw new Error('IDENTITY_UNAVAILABLE');
    try {
      await admin.auth().deleteUser(uid);
    } catch (error: unknown) {
      if (!this.isMissing(error)) throw error;
    }
    try {
      await admin.auth().getUser(uid);
    } catch (error: unknown) {
      if (this.isMissing(error)) return;
      throw error;
    }
    throw new Error('IDENTITY_STILL_EXISTS');
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'auth/user-not-found'
    );
  }
}

const publicSelection = {
  id: true,
  client_id: true,
  status: true,
  attempts: true,
  last_error: true,
  created_at: true,
  completed_at: true,
  settle_after: true,
  last_verified_at: true,
} satisfies Prisma.ClientDeletionSelect;

@Injectable()
export class ClientDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly identity: DeletionIdentityService,
  ) {}
  async request(clientId: string, requesterId: string, self = false) {
    return this.prisma.$transaction(
      async (tx) => {
        // Canonical order across double requests, roles, uploads and external writers.
        await tx.$queryRaw`SELECT id FROM users WHERE id IN (${clientId}, ${requesterId}) ORDER BY id FOR UPDATE`;
        if (!self) {
          const requester = await tx.user.findUnique({
            where: { id: requesterId },
          });
          if (
            requester?.role !== Role.SUPER_ADMIN ||
            !requester.is_active ||
            requester.is_locked ||
            requester.identity_pending
          ) {
            throw new ForbiddenException(
              'Solo un Super Admin puede eliminar clientes',
            );
          }
        } else if (clientId !== requesterId) {
          throw new ForbiddenException();
        }
        const previous = await tx.clientDeletion.findUnique({
          where: { client_id: clientId },
          select: publicSelection,
        });
        if (previous) return previous;
        const user = await tx.user.findUnique({
          where: { id: clientId },
          include: { profile: true, feedbackMedia: true, managedUploads: true },
        });
        if (!user) throw new NotFoundException('Cliente no encontrado');
        if (!self && user.role !== Role.CLIENT)
          throw new ForbiddenException(
            'Esta acción solo permite eliminar clientes',
          );

        // Old/imported sessions without a durable receipt are not cancelable.
        // Capture them before the User cascade; do not infer termination from status.
        for (const upload of user.managedUploads) {
          await tx.uploadTransfer.upsert({
            where: { id: upload.id },
            update: {},
            create: {
              id: upload.id,
              owner_id: clientId,
              object_key: upload.object_key,
              protocol: 'DIRECT',
              state: 'UNCERTAIN',
            },
          });
        }
        const transfers = await tx.uploadTransfer.findMany({
          where: { owner_id: clientId },
        });

        // Login may have rebound a completed identity to another UID. Do not
        // cancel that receipt and silently omit the previous external account.
        if (
          await tx.identityOperation.findFirst({
            where: {
              user_id: clientId,
              firebase_uid: { not: user.firebase_uid },
            },
            select: { id: true },
          })
        )
          throw this.ambiguous();

        const ownedIds = Prisma.sql`
          SELECT ${clientId}::text AS id
          UNION SELECT id FROM profiles WHERE user_id = ${clientId}
          UNION SELECT id FROM feedback_media WHERE client_id = ${clientId}
          UNION SELECT id FROM managed_uploads WHERE owner_id = ${clientId}
          UNION SELECT id FROM weekly_recaps WHERE client_id = ${clientId}
          UNION SELECT id FROM plan_assignments WHERE client_id = ${clientId}
          UNION SELECT id FROM day_progress WHERE client_id = ${clientId}
          UNION SELECT id FROM body_metrics WHERE client_id = ${clientId}
          UNION SELECT id FROM auto_assignment_rules WHERE client_id = ${clientId}
          UNION SELECT operation_id FROM rir_cycle_versions WHERE client_id = ${clientId}
          UNION SELECT id FROM identity_operations WHERE user_id = ${clientId}`;

        // Non-FK authorship indicates a previous administrative role. Shared
        // resources are never inferred to be owned by the current CLIENT.
        const shared = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM trainings WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM exercises WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM diets WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM ingredients WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM challenges WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM achievements WHERE created_by = ${clientId}
          UNION ALL SELECT 1 FROM feedback_media WHERE reviewed_by = ${clientId} AND client_id <> ${clientId}
          UNION ALL SELECT 1 FROM managed_uploads u JOIN approval_requests a ON a.id = u.approval_request_id WHERE a.requester_id = ${clientId} AND u.owner_id <> ${clientId}
          UNION ALL SELECT 1 FROM approval_requests WHERE requester_id <> ${clientId}
            AND EXISTS (SELECT 1 FROM (${ownedIds}) owned WHERE resource_id = owned.id OR position(owned.id in payload::text) > 0)
        ) AS found`);
        if (shared[0]?.found) throw this.ambiguous();

        const keys = new Set(
          user.managedUploads.map((upload) => upload.object_key),
        );
        for (const url of [
          user.profile?.avatar_url,
          ...user.feedbackMedia.map((item) => item.media_url),
        ]) {
          if (!url) continue;
          const key = this.uploads.extractManagedFileKey(url);
          if (!key) throw this.ambiguous();
          keys.add(key);
        }
        for (const transfer of transfers)
          if (transfer.object_key) keys.add(transfer.object_key);
        for (const key of keys) {
          // Stable namespaced ownership is required even for legacy URLs.
          if (
            !/^(avatar|feedback-image|feedback-video)\//.test(key) ||
            key.split('/')[1] !== clientId ||
            key.split('/').length !== 3
          ) {
            throw this.ambiguous();
          }
          const filename = key.split('/')[2];
          const references = await tx.$queryRaw<{ found: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM profiles WHERE user_id <> ${clientId} AND position(${filename} in avatar_url) > 0
            UNION ALL SELECT 1 FROM feedback_media WHERE client_id <> ${clientId} AND position(${filename} in media_url) > 0
            UNION ALL SELECT 1 FROM exercises WHERE position(${filename} in video_url) > 0 OR position(${filename} in thumbnail_url) > 0
            UNION ALL SELECT 1 FROM meals WHERE position(${filename} in image_url) > 0
            UNION ALL SELECT 1 FROM achievements WHERE position(${filename} in icon_url) > 0
            UNION ALL SELECT 1 FROM diet_day_snapshots WHERE client_id <> ${clientId} AND position(${filename} in diet::text) > 0
            UNION ALL SELECT 1 FROM managed_uploads WHERE owner_id <> ${clientId} AND object_key = ${key}
          ) AS found`;
          if (references[0]?.found) throw this.ambiguous();
        }

        const operation = await tx.clientDeletion.create({
          data: {
            client_id: clientId,
            requested_by: requesterId,
            firebase_uid: user.firebase_uid,
            object_keys: [...keys],
            // Expiry ends admission of old credentials, not an already accepted
            // request. Durable automatic reconciliation also covers late writes.
            settle_after: new Date(
              Date.now() +
                Math.max(
                  user.firebase_uid ? this.identity.credentialLifetimeMs() : 0,
                  keys.size ? this.uploads.credentialLifetimeMs() : 0,
                ),
            ),
          },
          select: publicSelection,
        });
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM notifications WHERE EXISTS (
            SELECT 1 FROM (${ownedIds}) owned WHERE position(owned.id in notifications.data::text) > 0
          )`);
        // FK cascades remove only this client's graph. Diet snapshot trigger
        // explicitly permits this cascade once the owning User is absent.
        await tx.user.delete({ where: { id: clientId } });
        // Identity intents must not resurrect a deleted account or retain a
        // fingerprint derived from its former email/profile. Keep only receipts.
        await tx.identityOperation.updateMany({
          where: { user_id: clientId },
          data: {
            status: 'CANCELLED',
            request_hash: '',
            completed_at: new Date(),
            last_error: null,
          },
        });
        return operation;
      },
      { timeout: 30000 },
    );
  }

  private ambiguous() {
    return new ConflictException({
      code: 'DELETION_OWNERSHIP_REVIEW',
      message:
        'Hay referencias o archivos cuya propiedad requiere revisión. No se ha eliminado el cliente.',
    });
  }

  list() {
    return this.prisma.clientDeletion.findMany({
      where: {
        OR: [
          { status: { not: 'COMPLETED' } },
          { completed_at: { gte: new Date(Date.now() - 7 * 86400000) } },
        ],
      },
      select: publicSelection,
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  async get(id: string) {
    const operation = await this.prisma.clientDeletion.findUnique({
      where: { id },
      select: publicSelection,
    });
    if (!operation) throw new NotFoundException('Operación no encontrada');
    return operation;
  }

  @Cron('*/30 * * * * *')
  async recover(): Promise<void> {
    const operations = await this.prisma.clientDeletion.findMany({
      where: {
        next_attempt_at: { lte: new Date() },
        OR: [
          { claimed_at: null },
          { claimed_at: { lt: new Date(Date.now() - 300000) } },
        ],
      },
      select: { id: true },
      orderBy: { next_attempt_at: 'asc' },
      take: 10,
    });
    for (const operation of operations) await this.process(operation.id);
  }
  async process(id: string): Promise<void> {
    const token = randomUUID();
    const now = new Date();
    const candidate = await this.prisma.clientDeletion.findUnique({
      where: { id },
    });
    if (!candidate) return;
    const auditing = candidate.status === 'COMPLETED';
    const claim = await this.prisma.clientDeletion.updateMany({
      where: {
        id,
        status: candidate.status,
        next_attempt_at: { lte: now },
        OR: [
          { claimed_at: null },
          { claimed_at: { lt: new Date(now.getTime() - 300000) } },
        ],
      },
      data: {
        status: auditing ? 'COMPLETED' : 'PROCESSING',
        claimed_at: now,
        claim_token: token,
        attempts: { increment: 1 },
      },
    });
    if (!claim.count) return;
    const operation = await this.prisma.clientDeletion.findUniqueOrThrow({
      where: { id },
    });
    let pendingStep = 'STORAGE_INVENTORY_PENDING';
    try {
      pendingStep = 'STORAGE_TRANSFER_PENDING';
      const transfersSettled =
        await this.uploads.cancelTransfersForClientDeletion(
          operation.client_id,
        );
      pendingStep = 'STORAGE_INVENTORY_PENDING';
      const settleAfter =
        operation.settle_after ??
        new Date(
          operation.created_at.getTime() +
            Math.max(
              operation.firebase_uid ? this.identity.credentialLifetimeMs() : 0,
              operation.object_keys.length
                ? this.uploads.credentialLifetimeMs()
                : 0,
            ),
        );
      const discovered = await this.uploads.discoverForClientDeletion(
        operation.client_id,
      );
      // Record a late object's exact key before issuing any deletion for it.
      const inventory = [...new Set([...operation.object_keys, ...discovered])];
      if (
        inventory.some(
          (key) =>
            !/^(avatar|feedback-image|feedback-video)\//.test(key) ||
            key.split('/').length !== 3 ||
            key.split('/')[1] !== operation.client_id,
        )
      ) {
        await this.finishAttempt(
          operation,
          token,
          'BLOCKED',
          'DELETION_OWNERSHIP_REVIEW',
        );
        return;
      }
      if (
        auditing &&
        transfersSettled &&
        !discovered.length &&
        (!operation.firebase_uid ||
          (await this.identity.isAbsent(operation.firebase_uid)))
      ) {
        await this.complete(operation, token, settleAfter, true);
        return;
      }
      let cursor = auditing ? 0 : operation.cleanup_cursor;
      if (cursor >= inventory.length && discovered.length) cursor = 0;
      const recorded = await this.prisma.clientDeletion.updateMany({
        where: { id, claim_token: token },
        data: {
          status: 'PROCESSING',
          completed_at: null,
          object_keys: inventory,
          cleanup_cursor: cursor,
          settle_after: settleAfter,
        },
      });
      if (!recorded.count) return;
      pendingStep = 'FIREBASE_CLEANUP_PENDING';
      if (operation.firebase_uid)
        await this.identity.remove(operation.firebase_uid);
      pendingStep = 'STORAGE_CLEANUP_PENDING';
      const end = Math.min(inventory.length, cursor + 100);
      for (const key of inventory.slice(cursor, end))
        await this.uploads.deleteAndVerifyForClientDeletion(key);
      const advanced = await this.prisma.clientDeletion.updateMany({
        where: { id, claim_token: token },
        data: { cleanup_cursor: end },
      });
      if (!advanced.count) return;
      if (end < inventory.length) {
        await this.defer(
          operation,
          token,
          'STORAGE_CLEANUP_PENDING',
          new Date(Date.now() + 5000),
        );
        return;
      }
      pendingStep = 'FINAL_VERIFICATION_PENDING';
      const late = await this.uploads.discoverForClientDeletion(
        operation.client_id,
      );
      if (late.length) {
        await this.prisma.clientDeletion.updateMany({
          where: { id, claim_token: token },
          data: {
            object_keys: [...new Set([...inventory, ...late])],
            cleanup_cursor: 0,
          },
        });
        await this.defer(
          operation,
          token,
          'LATE_RESOURCE_CLEANUP_PENDING',
          new Date(Date.now() + 5000),
        );
        return;
      }
      if (
        operation.firebase_uid &&
        !(await this.identity.isAbsent(operation.firebase_uid))
      ) {
        await this.defer(
          operation,
          token,
          'FIREBASE_CLEANUP_PENDING',
          new Date(Date.now() + 5000),
        );
        return;
      }
      if (Date.now() < settleAfter.getTime()) {
        await this.defer(operation, token, 'CREDENTIALS_EXPIRING', settleAfter);
        return;
      }
      if (!transfersSettled) {
        await this.defer(
          operation,
          token,
          'STORAGE_TRANSFER_PENDING',
          new Date(Date.now() + 3600000),
        );
        return;
      }
      await this.complete(operation, token, settleAfter);
    } catch {
      // Do not persist provider messages: they may contain URLs or credentials.
      await this.finishAttempt(operation, token, 'PENDING', pendingStep);
    }
  }

  private async complete(
    operation: ClientDeletion,
    token: string,
    settleAfter: Date,
    preserveCompletion = false,
  ) {
    const verified = new Date();
    if (verified < settleAfter) {
      await this.defer(operation, token, 'CREDENTIALS_EXPIRING', settleAfter);
      return;
    }
    await this.prisma.clientDeletion.updateMany({
      where: { id: operation.id, claim_token: token },
      data: {
        status: 'COMPLETED',
        completed_at: preserveCompletion
          ? (operation.completed_at ?? verified)
          : verified,
        last_verified_at: verified,
        settle_after: settleAfter,
        // Retain UID, client namespace and inventory for automatic late cleanup.
        // An expired URL does not prove a previously accepted PUT terminated.
        next_attempt_at: new Date(verified.getTime() + 3600000),
        claimed_at: null,
        claim_token: null,
        last_error: null,
      },
    });
  }

  private async defer(
    operation: ClientDeletion,
    token: string,
    code: string,
    next: Date,
  ) {
    await this.prisma.clientDeletion.updateMany({
      where: { id: operation.id, claim_token: token },
      data: {
        status: 'PENDING',
        completed_at: null,
        last_error: code,
        claimed_at: null,
        claim_token: null,
        next_attempt_at: next,
      },
    });
  }

  private finishAttempt(
    operation: ClientDeletion,
    token: string,
    status: string,
    code: string,
  ) {
    const delay =
      status === 'BLOCKED'
        ? 3600000
        : Math.min(3600000, 30000 * 2 ** Math.min(operation.attempts - 1, 7));
    return this.prisma.clientDeletion.updateMany({
      where: { id: operation.id, claim_token: token },
      data: {
        status,
        completed_at: null,
        last_error: code,
        claimed_at: null,
        claim_token: null,
        next_attempt_at: new Date(Date.now() + delay),
      },
    });
  }
  async deleteSelf(id: string) {
    const operation = await this.request(id, id, true);
    await this.process(operation.id);
    if ((await this.get(operation.id)).status !== 'COMPLETED') {
      // Older apps treat every 2xx as completed. Do not change that contract
      // to a false success when cleanup is still pending.
      throw new ServiceUnavailableException({
        code: 'ACCOUNT_DELETION_PENDING',
        message:
          'Tu cuenta ya no tiene acceso. Su eliminación está pendiente de confirmación.',
        operation_id: operation.id,
      });
    }
    return { success: true };
  }
}
