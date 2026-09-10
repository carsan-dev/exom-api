import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IdentityOperation, Prisma, Role } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IdentityProvider, identityErrorCode } from './identity-provider';

type UserWithProfile = Prisma.UserGetPayload<{ include: { profile: true } }>;
type CreateIdentity = {
  actorId: string;
  role: Role;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  fingerprint: unknown;
  key?: string;
};

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: IdentityProvider,
  ) {}

  private hash(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private key(actorId: string, key?: string, fallback: string = randomUUID()) {
    if (key && !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key inválida');
    }
    return this.hash([actorId, key || fallback]);
  }

  private pending(id: string): never {
    throw new ServiceUnavailableException({
      code: 'IDENTITY_RECOVERY_PENDING',
      operation_id: id,
      message: 'La operación de identidad está pendiente de confirmación.',
    });
  }

  private compensated(): never {
    throw new ConflictException({
      code: 'IDENTITY_OPERATION_COMPENSATED',
      message: 'El alta se ha revertido. Puedes iniciar una nueva solicitud.',
    });
  }

  private async lockUsers(tx: Prisma.TransactionClient, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
    }
  }

  private async authorize(
    tx: Prisma.TransactionClient,
    actorId: string,
    clientCreation = false,
  ) {
    const actor = await tx.user.findUnique({ where: { id: actorId } });
    if (
      !actor?.is_active ||
      actor.is_locked ||
      actor.identity_pending ||
      (actor.role !== Role.SUPER_ADMIN &&
        !(clientCreation && actor.role === Role.ADMIN))
    ) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }
  }

  async create(
    input: CreateIdentity,
    persist: (
      tx: Prisma.TransactionClient,
      uid: string,
      id: string,
    ) => Promise<UserWithProfile>,
  ): Promise<UserWithProfile> {
    const requestKey = this.key(
      input.actorId,
      input.key,
      this.hash(['CREATE', input.role, input.email]),
    );
    // Password is deliberately excluded: a retry returns the first account; it
    // never changes its password. No password or password hash is retained.
    const fingerprint = this.hash([input.role, input.email, input.fingerprint]);
    const operation = await this.prisma.$transaction(async (tx) => {
      await this.lockUsers(tx, [input.actorId]);
      await this.authorize(tx, input.actorId, input.role === Role.CLIENT);
      const previous = await tx.identityOperation.findUnique({
        where: { request_key: requestKey },
      });
      if (previous) {
        if (previous.request_hash !== fingerprint)
          throw new ConflictException('La clave pertenece a otra solicitud');
        return previous;
      }
      if (
        await tx.user.findFirst({
          where: { email: { equals: input.email, mode: 'insensitive' } },
        })
      ) {
        throw new ConflictException('El email ya está registrado');
      }
      return tx.identityOperation.create({
        data: {
          request_key: requestKey,
          request_hash: fingerprint,
          user_id: randomUUID(),
          actor_id: input.actorId,
          firebase_uid: `exom-${randomUUID()}`,
          kind: 'CREATE',
          next_attempt_at: new Date(Date.now() + 300000),
        },
      });
    });
    if (operation.status === 'COMPLETED') {
      const user = await this.prisma.user.findUnique({
        where: { id: operation.user_id },
        include: { profile: true },
      });
      if (!user)
        throw new ConflictException(
          'La cuenta de esta operación ya fue eliminada',
        );
      return user;
    }
    if (operation.status === 'COMPENSATED') this.compensated();
    if (operation.status !== 'PENDING' || operation.firebase_owned)
      this.pending(operation.id);

    let createIssued = false;
    try {
      // Lock intent while making the request. A duplicate caller waits, then
      // observes COMPLETED/owned instead of issuing a second create.
      await this.prisma.$transaction(
        async (tx) => {
          await this.lockUsers(tx, [input.actorId]);
          await this.authorize(tx, input.actorId, input.role === Role.CLIENT);
          await tx.$queryRaw`SELECT id FROM identity_operations WHERE id = ${operation.id} FOR UPDATE`;
          const current = await tx.identityOperation.findUniqueOrThrow({
            where: { id: operation.id },
          });
          if (current.status === 'COMPLETED' || current.firebase_owned) return;
          if (current.status !== 'PENDING') this.pending(current.id);
          if (await this.provider.get(current.firebase_uid))
            throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
          createIssued = true;
          const remote = await this.provider.create({
            uid: current.firebase_uid,
            email: input.email,
            password: input.password,
            displayName: `${input.firstName} ${input.lastName}`.trim(),
          });
          if (remote.uid !== current.firebase_uid)
            throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
          await tx.identityOperation.update({
            where: { id: current.id },
            data: { firebase_owned: true },
          });
        },
        { timeout: 300000 },
      );

      return await this.prisma.$transaction(
        async (tx) => {
          await this.lockUsers(tx, [input.actorId]);
          await this.authorize(tx, input.actorId, input.role === Role.CLIENT);
          await tx.$queryRaw`SELECT id FROM identity_operations WHERE id = ${operation.id} FOR UPDATE`;
          const current = await tx.identityOperation.findUniqueOrThrow({
            where: { id: operation.id },
          });
          if (current.status === 'COMPLETED')
            return tx.user.findUniqueOrThrow({
              where: { id: current.user_id },
              include: { profile: true },
            });
          if (current.status !== 'PENDING' || !current.firebase_owned)
            this.pending(current.id);
          const user = await persist(tx, current.firebase_uid, current.user_id);
          await tx.identityOperation.update({
            where: { id: current.id },
            data: { status: 'COMPLETED', completed_at: new Date() },
          });
          return user;
        },
        { timeout: 30000 },
      );
    } catch (error: unknown) {
      if (
        (!createIssued && !(error instanceof ConflictException)) ||
        ['auth/email-already-exists', 'auth/uid-already-exists'].includes(
          identityErrorCode(error) ?? '',
        )
      ) {
        await this.prisma.identityOperation.updateMany({
          where: { id: operation.id, status: 'PENDING', firebase_owned: false },
          data: {
            status: 'COMPENSATED',
            completed_at: new Date(),
            last_error: 'CREATE_NOT_APPLIED',
          },
        });
      }
      await this.recoverOperation(operation.id);
      if (identityErrorCode(error) === 'auth/email-already-exists')
        throw new ConflictException('El email ya está registrado en Firebase');
      const recovered = await this.prisma.identityOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      if (recovered.status === 'COMPENSATED') this.compensated();
      this.pending(operation.id);
    }
  }

  async change(
    actorId: string,
    userId: string,
    kind: 'SYNC' | 'REVOKE',
    fingerprint: unknown,
    mutate: (
      tx: Prisma.TransactionClient,
      user: UserWithProfile,
    ) => Promise<void>,
    key?: string,
  ): Promise<UserWithProfile> {
    const requestKey = this.key(actorId, key);
    const requestHash = this.hash([userId, kind, fingerprint]);
    const operation = await this.prisma.$transaction(async (tx) => {
      await this.lockUsers(tx, [actorId, userId]);
      if (kind !== 'REVOKE') await this.authorize(tx, actorId);
      else if (actorId !== userId) throw new ForbiddenException();
      const previous = await tx.identityOperation.findUnique({
        where: { request_key: requestKey },
      });
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new ConflictException('La clave pertenece a otra solicitud');
        return previous;
      }
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { profile: true },
      });
      if (!user) throw new NotFoundException('Usuario no encontrado');
      if (user.identity_pending)
        throw new ConflictException('Hay una operación de identidad pendiente');
      await mutate(tx, user);
      await tx.user.update({
        where: { id: userId },
        data: { identity_pending: true },
      });
      return tx.identityOperation.create({
        data: {
          request_key: requestKey,
          request_hash: requestHash,
          user_id: userId,
          actor_id: actorId,
          firebase_uid: user.firebase_uid,
          kind,
        },
      });
    });
    await this.recoverOperation(operation.id);
    const result = await this.prisma.identityOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    if (result.status !== 'COMPLETED') this.pending(result.id);
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { profile: true },
    });
  }

  async revoke(userId: string, key?: string): Promise<void> {
    await this.change(
      userId,
      userId,
      'REVOKE',
      'logout',
      async (tx, user) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            sessions_revoked_at: new Date(
              Math.max(
                Date.now(),
                (user.sessions_revoked_at?.getTime() ?? 0) + 1,
              ),
            ),
          },
        });
      },
      key,
    );
  }

  async recoverOperation(id: string): Promise<void> {
    const initial = await this.prisma.identityOperation.findUnique({
      where: { id },
    });
    if (!initial || !['PENDING', 'BLOCKED'].includes(initial.status)) return;
    let uncertain = initial.last_error === 'FIREBASE_OUTCOME_REVIEW';
    let generation: number | undefined;
    let writeInFlight = false;
    // Commit this marker before starting a mutable external request. If the
    // process/DB connection dies, a successor cannot claim a lost RPC drained.
    if (initial.kind !== 'CREATE') {
      // Read the previous marker under the same row lock as its replacement.
      // Two workers can have read the same stale initial snapshot above.
      const previous = await this.prisma.$queryRaw<
        { last_error: string | null; attempts: number }[]
      >`WITH previous AS (
          SELECT id, last_error FROM identity_operations
          WHERE id = ${id} AND status IN ('PENDING', 'BLOCKED') FOR UPDATE
        )
        UPDATE identity_operations AS operation
        SET last_error = 'FIREBASE_OUTCOME_REVIEW', attempts = operation.attempts + 1
        FROM previous WHERE operation.id = previous.id
        RETURNING previous.last_error, operation.attempts`;
      if (!previous.length) return;
      uncertain = previous[0].last_error === 'FIREBASE_OUTCOME_REVIEW';
      generation = previous[0].attempts;
    }
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await this.lockUsers(tx, [initial.user_id]);
          await tx.$queryRaw`SELECT id FROM identity_operations WHERE id = ${id} FOR UPDATE`;
          const operation = await tx.identityOperation.findUniqueOrThrow({
            where: { id },
          });
          if (!['PENDING', 'BLOCKED'].includes(operation.status)) return;
          // A successor can replace our marker before we acquire User. The
          // durable attempt number fences both execution and a delayed catch.
          if (generation !== undefined && operation.attempts !== generation)
            return;
          const user = await tx.user.findUnique({
            where: { id: operation.user_id },
            include: { profile: true },
          });
          if (operation.kind === 'CREATE') {
            if (
              user ||
              (await tx.user.findUnique({
                where: { firebase_uid: operation.firebase_uid },
              }))
            ) {
              throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
            }
            // A crash before ownership acknowledgement is ambiguous. Never delete
            // an account merely because its email happens to match the request.
            if (!operation.firebase_owned)
              throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
            await this.provider.remove(operation.firebase_uid);
            await this.finish(tx, operation, 'COMPENSATED');
            return;
          }
          if (!user) {
            const deletion = await tx.clientDeletion.findUnique({
              where: { client_id: operation.user_id },
            });
            if (!deletion || deletion.firebase_uid !== operation.firebase_uid)
              throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
            await this.finish(tx, operation, 'CANCELLED');
            return;
          }
          if (user.firebase_uid !== operation.firebase_uid)
            throw new ConflictException('IDENTITY_OWNERSHIP_REVIEW');
          const remote = await this.provider.get(operation.firebase_uid);
          if (!remote) throw new ConflictException('IDENTITY_MISSING_REVIEW');
          if (operation.kind === 'SYNC') {
            writeInFlight = true;
            await this.provider.update(operation.firebase_uid, {
              email: user.email,
              disabled: !user.is_active,
              displayName: user.profile
                ? `${user.profile.first_name} ${user.profile.last_name}`.trim()
                : undefined,
            });
            writeInFlight = false;
          }
          if (operation.kind === 'REVOKE' || !user.is_active) {
            writeInFlight = true;
            await this.provider.revoke(operation.firebase_uid);
            writeInFlight = false;
          }
          const verified = await this.provider.get(operation.firebase_uid);
          if (
            !verified ||
            verified.email?.toLowerCase() !== user.email.toLowerCase() ||
            verified.disabled !== !user.is_active
          ) {
            throw new ConflictException('IDENTITY_DIVERGENCE_REVIEW');
          }
          if (uncertain) {
            await tx.identityOperation.update({
              where: { id },
              data: {
                status: 'BLOCKED',
                last_error: 'FIREBASE_OUTCOME_REVIEW',
                next_attempt_at: new Date(Date.now() + 3600000),
              },
            });
            return;
          }
          await tx.user.update({
            where: { id: user.id },
            data: { identity_pending: false },
          });
          await this.finish(tx, operation, 'COMPLETED');
        },
        { timeout: 300000 },
      );
    } catch (error: unknown) {
      // Codes only: provider messages may contain email, signed URLs or secrets.
      const blocked = error instanceof ConflictException;
      const rejected = [
        'auth/email-already-exists',
        'auth/uid-already-exists',
        'auth/insufficient-permission',
        'auth/invalid-email',
        'auth/user-not-found',
      ].includes(identityErrorCode(error) ?? '');
      const review = uncertain || (writeInFlight && !rejected);
      await this.prisma.identityOperation.updateMany({
        where: {
          id,
          status: { in: ['PENDING', 'BLOCKED'] },
          ...(generation !== undefined ? { attempts: generation } : {}),
        },
        data: {
          status: blocked || review ? 'BLOCKED' : 'PENDING',
          ...(generation === undefined ? { attempts: { increment: 1 } } : {}),
          last_error: review
            ? 'FIREBASE_OUTCOME_REVIEW'
            : blocked
              ? 'IDENTITY_REVIEW_REQUIRED'
              : initial.kind === 'CREATE'
                ? 'CREATE_COMPENSATION_PENDING'
                : 'FIREBASE_SYNC_PENDING',
          next_attempt_at: new Date(
            Date.now() + (blocked || review ? 3600000 : 30000),
          ),
        },
      });
    }
  }

  private finish(
    tx: Prisma.TransactionClient,
    operation: IdentityOperation,
    status: string,
  ) {
    return tx.identityOperation.update({
      where: { id: operation.id },
      data: {
        status,
        completed_at: new Date(),
        last_error: null,
        ...(operation.kind === 'CREATE' ? { attempts: { increment: 1 } } : {}),
      },
    });
  }

  @Cron('*/30 * * * * *')
  async recover(): Promise<void> {
    const operations = await this.prisma.identityOperation.findMany({
      where: {
        status: { in: ['PENDING', 'BLOCKED'] },
        next_attempt_at: { lte: new Date() },
      },
      orderBy: { next_attempt_at: 'asc' },
      take: 10,
      select: { id: true },
    });
    for (const operation of operations)
      await this.recoverOperation(operation.id);
  }
}
