import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ManagedUploadPurpose,
  Prisma,
  ProgressPhotoState,
  ProgressPhotoView,
  Role,
} from '@prisma/client';
import { formatDateOnly, parseDateOnly } from '../../common/date-only';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  AssociateProgressPhotoDto,
  CreateProgressPhotoSessionDto,
  ProgressPhotoHistoryQueryDto,
} from './dto/progress-photo.dto';

type PhotoWithUpload = Prisma.ProgressPhotoGetPayload<{
  include: { managed_upload: true };
}>;
type SessionWithActivePhotos = Prisma.ProgressPhotoSessionGetPayload<{
  include: {
    photos: {
      where: { state: 'ACTIVE' };
      include: { managed_upload: true };
    };
  };
}>;

const TRANSACTION_ATTEMPTS = 3;

@Injectable()
export class ProgressPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  async getHistory(
    actor: AuthenticatedUser,
    clientId: string,
    query: ProgressPhotoHistoryQueryDto,
  ) {
    await this.assertClientAccess(actor, clientId);
    const [sessions, total] = await Promise.all([
      this.prisma.progressPhotoSession.findMany({
        where: { client_id: clientId },
        orderBy: [{ session_date: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
        include: {
          photos: {
            where: { state: ProgressPhotoState.ACTIVE },
            orderBy: [{ view: 'asc' }, { id: 'asc' }],
            include: { managed_upload: true },
          },
        },
      }),
      this.prisma.progressPhotoSession.count({
        where: { client_id: clientId },
      }),
    ]);

    return {
      data: await Promise.all(
        sessions.map((session) => this.serializeSession(session)),
      ),
      total,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      totalPages: Math.ceil(total / (query.limit ?? 20)),
    };
  }

  async getSession(
    actor: AuthenticatedUser,
    clientId: string,
    sessionId: string,
  ) {
    await this.assertClientAccess(actor, clientId);
    const session = await this.prisma.progressPhotoSession.findFirst({
      where: { id: sessionId, client_id: clientId },
      include: {
        photos: {
          where: { state: ProgressPhotoState.ACTIVE },
          orderBy: [{ view: 'asc' }, { id: 'asc' }],
          include: { managed_upload: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Sesión de fotos no encontrada');
    return this.serializeSession(session);
  }

  async createSession(
    actor: AuthenticatedUser,
    clientId: string,
    dto: CreateProgressPhotoSessionDto,
  ) {
    await this.assertClientAccess(actor, clientId);
    const sessionDate = parseDateOnly(dto.session_date, 'session_date');
    let id: string;
    try {
      id = await this.withRetryableTransaction(async (tx) => {
        await this.lock(
          tx,
          `exom:progress-photo:session:${actor.id}:${dto.operation_id}`,
        );
        const existing = await tx.progressPhotoSession.findUnique({
          where: {
            uploader_id_session_operation_id: {
              uploader_id: actor.id,
              session_operation_id: dto.operation_id,
            },
          },
        });
        if (existing) {
          return this.sessionReplayId(existing, clientId, sessionDate);
        }
        const created = await tx.progressPhotoSession.create({
          data: {
            client_id: clientId,
            uploader_id: actor.id,
            session_date: sessionDate,
            session_operation_id: dto.operation_id,
          },
        });
        return created.id;
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      const existing = await this.prisma.progressPhotoSession.findUnique({
        where: {
          uploader_id_session_operation_id: {
            uploader_id: actor.id,
            session_operation_id: dto.operation_id,
          },
        },
      });
      if (!existing) {
        throw this.operationConflict('La sesión ya existe con otra operación');
      }
      id = this.sessionReplayId(existing, clientId, sessionDate);
    }
    return this.getSession(actor, clientId, id);
  }

  async associatePhoto(
    actor: AuthenticatedUser,
    clientId: string,
    sessionId: string,
    dto: AssociateProgressPhotoDto,
  ) {
    await this.assertClientAccess(actor, clientId);
    let photoId: string;
    try {
      photoId = await this.withRetryableTransaction(async (tx) => {
        await this.lockMany(tx, [
          `exom:progress-photo:association:${actor.id}:${dto.operation_id}`,
          `exom:progress-photo:view:${sessionId}:${dto.view}`,
        ]);
        const existing = await tx.progressPhoto.findUnique({
          where: {
            uploader_id_association_operation_id: {
              uploader_id: actor.id,
              association_operation_id: dto.operation_id,
            },
          },
        });
        if (existing)
          return this.associationReplayId(existing, clientId, sessionId, dto);

        const session = await tx.progressPhotoSession.findFirst({
          where: { id: sessionId, client_id: clientId },
          select: { id: true },
        });
        if (!session)
          throw new NotFoundException('Sesión de fotos no encontrada');

        const active = await tx.progressPhoto.findFirst({
          where: {
            session_id: sessionId,
            view: dto.view,
            state: ProgressPhotoState.ACTIVE,
          },
          select: { id: true },
        });
        if (active) {
          if (dto.replaces_photo_id !== active.id) {
            throw this.replacementPrecondition(
              'La sustitución debe identificar la foto activa actual de esta vista',
            );
          }
          const replaced = await tx.progressPhoto.updateMany({
            where: { id: active.id, state: ProgressPhotoState.ACTIVE },
            data: { state: ProgressPhotoState.REPLACED },
          });
          if (replaced.count !== 1) {
            throw this.replacementConflict();
          }
        } else if (dto.replaces_photo_id) {
          throw this.replacementPrecondition(
            'No existe una foto activa que sustituir en esta vista',
          );
        }

        await this.uploadsService.consumePrepared(tx, actor.id, dto.upload_id, [
          ManagedUploadPurpose.PROGRESS_PHOTO,
        ]);
        const created = await tx.progressPhoto.create({
          data: {
            session_id: sessionId,
            client_id: clientId,
            uploader_id: actor.id,
            managed_upload_id: dto.upload_id,
            view: dto.view,
            association_operation_id: dto.operation_id,
            replaces_photo_id: dto.replaces_photo_id,
          },
        });
        return created.id;
      });
    } catch (error) {
      if (!this.isUniqueConstraint(error)) throw error;
      photoId = await this.resolveUniqueAssociation(
        actor.id,
        clientId,
        sessionId,
        dto,
      );
    }
    return this.getPhoto(actor, clientId, photoId);
  }

  async readPhotoFile(
    actor: AuthenticatedUser,
    photoId: string,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const photo = await this.prisma.progressPhoto.findUnique({
      where: { id: photoId },
      select: { client_id: true, managed_upload_id: true },
    });
    if (!photo) throw new NotFoundException('Foto de progreso no encontrada');
    await this.assertClientAccess(actor, photo.client_id);
    return this.uploadsService.readLocalProgressPhoto(photo.managed_upload_id);
  }

  private async getPhoto(
    actor: AuthenticatedUser,
    clientId: string,
    photoId: string,
  ) {
    const photo = await this.prisma.progressPhoto.findFirst({
      where: { id: photoId, client_id: clientId },
      include: { managed_upload: true },
    });
    if (!photo) throw new NotFoundException('Foto de progreso no encontrada');
    await this.assertClientAccess(actor, clientId);
    return this.serializePhoto(photo);
  }

  private async serializeSession(session: SessionWithActivePhotos) {
    const photos = await Promise.all(
      session.photos.map((photo) => this.serializePhoto(photo)),
    );
    return {
      id: session.id,
      session_date: formatDateOnly(session.session_date),
      created_at: session.created_at,
      updated_at: session.updated_at,
      is_complete: photos.length === Object.values(ProgressPhotoView).length,
      photos,
    };
  }

  private async serializePhoto(photo: PhotoWithUpload) {
    return {
      id: photo.id,
      view: photo.view,
      state: photo.state,
      replaces_photo_id: photo.replaces_photo_id,
      created_at: photo.created_at,
      image_url: await this.uploadsService.getProgressPhotoReadUrl(
        photo.id,
        `r2://${photo.managed_upload.object_key}`,
      ),
      content_type: photo.managed_upload.mime_type,
      bytes:
        photo.managed_upload.actual_bytes ??
        photo.managed_upload.expected_bytes,
    };
  }

  private async assertClientAccess(actor: AuthenticatedUser, clientId: string) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });
    if (!client || client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }
    if (actor.role === Role.CLIENT) {
      if (actor.id !== clientId) {
        throw new ForbiddenException(
          'No tienes permisos para acceder a este cliente',
        );
      }
      return;
    }
    if (actor.role === Role.SUPER_ADMIN) return;
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'No tienes permisos para acceder a este cliente',
      );
    }
    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: { admin_id: actor.id, client_id: clientId, is_active: true },
      select: { id: true },
    });
    if (!assignment)
      throw new ForbiddenException('Este cliente no está asignado a ti');
  }

  private sessionReplayId(
    existing: { id: string; client_id: string; session_date: Date },
    clientId: string,
    sessionDate: Date,
  ) {
    if (
      existing.client_id !== clientId ||
      existing.session_date.getTime() !== sessionDate.getTime()
    ) {
      throw this.operationConflict('La operación ya identifica otra sesión');
    }
    return existing.id;
  }

  private associationReplayId(
    existing: {
      id: string;
      session_id: string;
      client_id: string;
      managed_upload_id: string;
      view: ProgressPhotoView;
      replaces_photo_id: string | null;
    },
    clientId: string,
    sessionId: string,
    dto: AssociateProgressPhotoDto,
  ) {
    if (
      existing.session_id !== sessionId ||
      existing.client_id !== clientId ||
      existing.managed_upload_id !== dto.upload_id ||
      existing.view !== dto.view ||
      existing.replaces_photo_id !== (dto.replaces_photo_id ?? null)
    ) {
      throw this.operationConflict('La operación ya identifica otra foto');
    }
    return existing.id;
  }

  private async resolveUniqueAssociation(
    actorId: string,
    clientId: string,
    sessionId: string,
    dto: AssociateProgressPhotoDto,
  ) {
    const existing = await this.prisma.progressPhoto.findUnique({
      where: {
        uploader_id_association_operation_id: {
          uploader_id: actorId,
          association_operation_id: dto.operation_id,
        },
      },
    });
    if (existing)
      return this.associationReplayId(existing, clientId, sessionId, dto);

    const active = await this.prisma.progressPhoto.findFirst({
      where: {
        session_id: sessionId,
        view: dto.view,
        state: ProgressPhotoState.ACTIVE,
      },
      select: { id: true },
    });
    if (active || dto.replaces_photo_id) {
      throw this.replacementPrecondition(
        'La foto activa cambió; vuelve a consultar la sesión',
      );
    }
    throw new ConflictException({
      code: 'PROGRESS_PHOTO_ASSOCIATION_CONFLICT',
      message: 'La subida ya está asociada a otra foto',
    });
  }

  private operationConflict(message: string) {
    return new ConflictException({
      code: 'PROGRESS_PHOTO_OPERATION_CONFLICT',
      message,
    });
  }

  private replacementPrecondition(message: string) {
    return new ConflictException({
      code: 'PROGRESS_PHOTO_REPLACEMENT_PRECONDITION',
      message,
    });
  }

  private replacementConflict() {
    return new ConflictException({
      code: 'PROGRESS_PHOTO_REPLACEMENT_CONFLICT',
      message: 'La foto activa cambió; vuelve a consultar la sesión',
    });
  }

  private concurrencyConflict() {
    return new ConflictException({
      code: 'PROGRESS_PHOTO_CONCURRENCY_CONFLICT',
      message:
        'La operación no pudo completarse de forma concurrente; vuelve a intentarlo',
    });
  }

  private async withRetryableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation);
      } catch (error) {
        if (!this.isRetryableTransactionConflict(error)) throw error;
        if (attempt === TRANSACTION_ATTEMPTS) {
          throw this.concurrencyConflict();
        }
      }
    }
    throw this.concurrencyConflict();
  }

  private isRetryableTransactionConflict(error: unknown) {
    const codes = this.errorCodes(error);
    return (
      codes.includes('P2034') ||
      codes.includes('40001') ||
      codes.includes('40P01')
    );
  }

  private isUniqueConstraint(error: unknown) {
    return this.errorCodes(error).includes('P2002');
  }

  private errorCodes(error: unknown): string[] {
    const codes: string[] = [];
    let current = error;
    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current !== 'object' || current === null) break;
      if ('code' in current && typeof current.code === 'string') {
        codes.push(current.code);
      }
      current = 'cause' in current ? current.cause : undefined;
    }
    return codes;
  }

  private async lock(tx: Prisma.TransactionClient, key: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text AS "locked"`,
    );
  }

  private async lockMany(tx: Prisma.TransactionClient, keys: string[]) {
    for (const key of [...new Set(keys)].sort()) {
      await this.lock(tx, key);
    }
  }
}
