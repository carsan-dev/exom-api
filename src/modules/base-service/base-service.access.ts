import { Prisma, Role } from '@prisma/client';
import { BASE_SERVICE_ROLES } from './base-service.constants';
import { baseHttp } from './base-service.http-errors';
import { BaseServiceError } from './base-service.error';
import { listRoutes } from './base-package-selection';

/**
 * Options of every base-service write transaction. An archive may wait for an
 * in-flight send (send barrier below) for up to the 60 s provider timeout, and
 * writers queued behind that archive on the subscriber row wait with it.
 */
export const BASE_WRITE_TX = {
  timeout: 90_000,
  maxWait: 10_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
};

export interface BaseServiceActor {
  id: string;
  role: string;
}

export function isBaseServiceRole(role: string): boolean {
  return BASE_SERVICE_ROLES.some((allowed: Role) => allowed === role);
}

/**
 * Re-checks the caller inside the write transaction (role changes and
 * deactivation since the guard ran). FOR SHARE holds that state until commit.
 * Lock order of every base-service writer: users -> base_subscribers ->
 * base_deliveries.
 */
export async function lockStaffActor(
  tx: Prisma.TransactionClient,
  actor: BaseServiceActor,
): Promise<void> {
  if (!isBaseServiceRole(actor.role))
    throw baseHttp.forbidden(
      'STAFF_ACCESS_REQUIRED',
      'No tienes permisos para gestionar el servicio base.',
    );
  const [row] = await tx.$queryRaw<
    {
      role: string;
      is_active: boolean;
      is_locked: boolean;
      is_archived: boolean;
      identity_pending: boolean;
    }[]
  >`SELECT role::text AS role, is_active, is_locked, is_archived, identity_pending
    FROM users WHERE id = ${actor.id} FOR SHARE`;
  if (
    !row ||
    row.role !== actor.role ||
    !row.is_active ||
    row.is_locked ||
    row.is_archived ||
    row.identity_pending
  )
    throw baseHttp.forbidden(
      'STAFF_ACCESS_CHANGED',
      'Tu acceso de administración ha cambiado. Vuelve a iniciar sesión.',
    );
}

/**
 * Archive-vs-send barrier of one subscriber. The worker holds it SHARED on its
 * work-guard connection (pinned for the whole work item anyway, no Prisma
 * transaction) from before its archive check until the provider answered; an
 * archive takes it EXCLUSIVE in its transaction, after the subscriber row lock.
 * So an archive either commits before a send checks the subscriber (the send
 * is refused) or waits until that provider call finished. Every writer that
 * sets is_archived = true must take it.
 */
export function subscriberSendBarrierKey(subscriberId: string): string {
  return `exom:base-subscriber-send:${subscriberId}`;
}

export async function lockSubscriberSendBarrier(
  tx: Prisma.TransactionClient,
  subscriberId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${subscriberSendBarrierKey(subscriberId)}, 0))::text AS locked`;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/** Rejects a (goal, days) pair the catalogue does not offer. */
export function assertRouteExists(
  keys: readonly string[],
  goal: string,
  days: number,
): void {
  const routes = listRoutes(keys);
  if (routes.length === 0)
    throw new BaseServiceError(
      'EMPTY_CATALOG',
      'No hay contenido de entrenamiento en el origen.',
    );
  const route = routes.find((entry) => entry.objetivo === goal);
  if (!route)
    throw new BaseServiceError(
      'INVALID_GOAL',
      `Objetivo no válido: «${goal}». Disponibles: ${routes.map((entry) => entry.objetivo).join(', ')}.`,
    );
  if (!route.dias.includes(days))
    throw new BaseServiceError(
      'INVALID_DAYS',
      `Días por semana no válidos: ${days}. Disponibles para ${goal}: ${route.dias.join(', ')}.`,
    );
}
