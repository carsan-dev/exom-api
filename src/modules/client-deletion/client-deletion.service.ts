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
  requiresDeletionDrainReview(): boolean {
    // Previously minted custom tokens can create the UID again. Existing
    // records do not prove that those credentials and in-flight RPCs drained.
    return true;
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
            // Direct presigned PUTs are not revoked by DELETE. Without a proven
            // drain contract keep inventory and a truthful BLOCKED state (ISSUE-042).
            storage_review:
              keys.size > 0 && this.uploads.requiresDeletionDrainReview(),
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
        status: { not: 'COMPLETED' },
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
    const claim = await this.prisma.clientDeletion.updateMany({
      where: {
        id,
        status: { not: 'COMPLETED' },
        next_attempt_at: { lte: now },
        OR: [
          { claimed_at: null },
          { claimed_at: { lt: new Date(now.getTime() - 300000) } },
        ],
      },
      data: {
        status: 'PROCESSING',
        claimed_at: now,
        claim_token: token,
        attempts: { increment: 1 },
      },
    });
    if (!claim.count) return;
    const operation = await this.prisma.clientDeletion.findUniqueOrThrow({
      where: { id },
    });
    let pendingStep = 'FIREBASE_CLEANUP_PENDING';
    try {
      if (operation.firebase_uid)
        await this.identity.remove(operation.firebase_uid);
      pendingStep = 'STORAGE_CLEANUP_PENDING';
      for (const key of operation.object_keys)
        await this.uploads.deleteAndVerifyForClientDeletion(key);
      if (operation.storage_review) {
        await this.finishAttempt(
          operation,
          token,
          'BLOCKED',
          'UPLOAD_DRAIN_REVIEW_REQUIRED',
        );
        return;
      }
      if (
        operation.firebase_uid &&
        this.identity.requiresDeletionDrainReview()
      ) {
        await this.finishAttempt(
          operation,
          token,
          'BLOCKED',
          'AUTH_DRAIN_REVIEW_REQUIRED',
        );
        return;
      }
      await this.prisma.clientDeletion.updateMany({
        where: { id, claim_token: token },
        data: {
          status: 'COMPLETED',
          completed_at: new Date(),
          // Keep the opaque identity tombstone: an old token must never bind
          // this Firebase UID to a newly created EXOM account after completion.
          object_keys: [],
          claimed_at: null,
          claim_token: null,
          last_error: null,
        },
      });
    } catch {
      // Do not persist provider messages: they may contain URLs or credentials.
      await this.finishAttempt(operation, token, 'PENDING', pendingStep);
    }
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
