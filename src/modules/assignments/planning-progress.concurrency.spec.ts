import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'planning and progress PostgreSQL interleaving',
  () => {
    it('waits for in-flight first progress before deciding whether today is mutable', async () => {
      const pool = new Pool({ connectionString: url });
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
      const writer = await pool.connect();
      const clientId = `planning-review-${process.pid}-${Date.now()}`;
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      let reconciliation: Promise<void> | undefined;
      try {
        await prisma.user.create({
          data: {
            id: clientId,
            firebase_uid: clientId,
            email: `${clientId}@example.test`,
          },
        });
        const rule = await prisma.autoAssignmentRule.create({
          data: {
            client_id: clientId,
            starts_on: date,
            source_week_start: date,
            is_active: false,
          },
        });
        const assignment = await prisma.planAssignment.create({
          data: { client_id: clientId, date, auto_assignment_rule_id: rule.id },
        });
        await writer.query('BEGIN');
        await writer.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`exom:day-progress:${clientId}`],
        );
        const materializer = new AutoAssignmentMaterializerService(
          prisma as unknown as PrismaService,
          new LastSetVideoPolicyService(prisma as unknown as PrismaService),
        );
        let finished = false;
        reconciliation = materializer
          .reconcile(clientId, { start: date, end: date, dates: [date] })
          .finally(() => {
            finished = true;
          });
        // Observe an actual waiting PostgreSQL lock, not just two Promise calls.
        let waiting = false;
        for (
          let attempt = 0;
          attempt < 200 && !finished && !waiting;
          attempt++
        ) {
          const locks = await writer.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting",
          );
          waiting = locks.rows[0].waiting;
          if (!waiting && !finished)
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // FK acquisition now also exercises advisory-before-user-row ordering.
        await writer.query(
          "INSERT INTO day_progress (id, client_id, date, exercises_completed, meals_completed, trainings_completed, notes, updated_at) VALUES ($1, $1, $2, '[]', '{}', '{}', 'first real note', CURRENT_TIMESTAMP)",
          [clientId, date],
        );
        await writer.query('COMMIT');
        await reconciliation;
        expect(waiting).toBe(true);
        expect(
          await prisma.planAssignment.findUnique({
            where: { id: assignment.id },
          }),
        ).not.toBeNull();
      } finally {
        await writer.query('ROLLBACK');
        await reconciliation;
        writer.release();
        await prisma.user.deleteMany({ where: { id: clientId } });
        await prisma.$disconnect();
        await pool.end();
      }
    }, 15000);
  },
);
