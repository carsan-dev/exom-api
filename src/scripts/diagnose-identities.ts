import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { initFirebase } from '../config/firebase.config';
import { compareIdentity } from '../modules/identity/identity-diagnostic';
import { IdentityProvider } from '../modules/identity/identity-provider';

// No repair mode. Reject --apply/unknown switches before opening any connection.
async function main() {
  if (process.argv.slice(2).some((argument) => argument !== '--read-only')) {
    throw new Error('READ_ONLY_COMMAND');
  }
  if (!process.env.DATABASE_URL || !process.env.FIREBASE_PROJECT_ID)
    throw new Error('CONFIGURATION_REQUIRED');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on',
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const provider = new IdentityProvider();
  const report: Record<string, number> = {};
  const emit = (codes: string[], id: string) => {
    for (const code of codes) {
      report[code] = (report[code] ?? 0) + 1;
      // Even custom Firebase UIDs can contain personal data; report digests only.
      console.log(
        JSON.stringify({
          code,
          reference: createHash('sha256').update(id).digest('hex'),
        }),
      );
    }
  };
  try {
    initFirebase();
    let cursor: string | undefined;
    for (;;) {
      const users = await prisma.user.findMany({
        take: 200,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          email: true,
          firebase_uid: true,
          is_active: true,
          identity_pending: true,
        },
      });
      for (const user of users)
        emit(
          compareIdentity(user, await provider.get(user.firebase_uid)),
          user.id,
        );
      if (users.length < 200) break;
      cursor = users[users.length - 1].id;
    }
    let pageToken: string | undefined;
    do {
      const page = await admin.auth().listUsers(200, pageToken);
      for (const remote of page.users) {
        if (
          await prisma.user.findUnique({
            where: { firebase_uid: remote.uid },
            select: { id: true },
          })
        )
          continue;
        const deletion = await prisma.clientDeletion.findFirst({
          where: { firebase_uid: remote.uid },
          select: { id: true },
        });
        const operation = await prisma.identityOperation.findFirst({
          where: {
            firebase_uid: remote.uid,
            status: { in: ['PENDING', 'BLOCKED'] },
          },
          select: { id: true },
        });
        const otherOwner = remote.email
          ? await prisma.user.findFirst({
              where: { email: { equals: remote.email, mode: 'insensitive' } },
              select: { id: true },
            })
          : null;
        emit(
          [
            deletion
              ? 'DELETION_PENDING'
              : operation
                ? 'RECOVERY_PENDING'
                : otherOwner
                  ? 'AMBIGUOUS_EMAIL_OWNER'
                  : 'POSTGRES_MISSING',
          ],
          remote.uid,
        );
      }
      pageToken = page.pageToken;
    } while (pageToken);
    console.log(
      JSON.stringify({
        complete: true,
        mode: 'read-only',
        findings: report,
        consistency:
          'Paginated observations; concurrent changes require a second diagnosis, never automatic repair.',
      }),
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
    for (const app of admin.apps) if (app) await app.delete();
  }
}

void main().catch(() => {
  console.error(
    'IDENTITY_DIAGNOSTIC_INCOMPLETE: revisar configuración/conexión; no se ha reparado ningún dato.',
  );
  process.exitCode = 1;
});
