import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { RirCycleService } from './rir-cycle.service';
import { AssignmentsService } from './assignments.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { lockAssignmentPlanning } from './assignment-planning-lock';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';
import { TrainingsService } from '../trainings/trainings.service';
import { monday, resolveRir } from './rir-cycle';
import type { UpdateRirCycleDto } from './dto/rir-cycle.dto';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'RIR PostgreSQL integration and observed interleavings',
  () => {
    let db: PrismaClient,
      pool: Pool,
      service: RirCycleService,
      client: string,
      admin: string,
      training: string,
      exercise: string;
    let occurrences: string[];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const date = (days: number) => new Date(today.getTime() + days * 86400000);
    const str = (d: Date) => d.toISOString().slice(0, 10);
    const actor = () => ({
      id: admin,
      role: Role.SUPER_ADMIN,
      email: 'rir@example.test',
      firebase_uid: admin,
    });
    const body = (revision = 0, days = 0): UpdateRirCycleDto => ({
      operation_id: randomUUID(),
      expected_revision: revision,
      effective_from: str(date(days)),
      starts_on: str(today),
      config: { sequence: [3, 2, 1, 0], overrides: {} },
    });
    const target = async (d = today, id = occurrences[0]) =>
      (
        await db.rirDayTarget.findUniqueOrThrow({
          where: {
            client_id_date_training_exercise_id: {
              client_id: client,
              date: d,
              training_exercise_id: id,
            },
          },
        })
      ).target_rir;
    function assign(d: Date, c = client) {
      return db.planAssignment.create({
        data: {
          client_id: c,
          date: d,
          training_id: training,
          trainings: { create: { training_id: training, position: 0 } },
        },
      });
    }
    beforeAll(() => {
      pool = new Pool({ connectionString: url });
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      service = new RirCycleService(db as unknown as PrismaService);
    });
    beforeEach(async () => {
      client = randomUUID();
      admin = randomUUID();
      await db.user.createMany({
        data: [
          {
            id: client,
            firebase_uid: client,
            email: `${client}@example.test`,
            role: Role.CLIENT,
          },
          {
            id: admin,
            firebase_uid: admin,
            email: `${admin}@example.test`,
            role: Role.SUPER_ADMIN,
          },
        ],
      });
      const t = await db.training.create({
        data: { name: 'RIR fixture', type: 'FUERZA', tags: [] },
      });
      training = t.id;
      const e = await db.exercise.create({
        data: { name: 'Repeated exercise', muscle_groups: [] },
      });
      exercise = e.id;
      const block = await db.trainingBlock.create({
        data: { training_id: training, order: 1, type: 'CIRCUIT', rounds: 2 },
      });
      occurrences = [];
      for (let i = 0; i < 3; i++)
        occurrences.push(
          (
            await db.trainingExercise.create({
              data: {
                training_id: training,
                exercise_id: exercise,
                order: i,
                sets: 3,
                reps_or_duration: '10',
                target_rir: 8,
                ...(i ? { block_id: block.id, position_in_block: i } : {}),
              },
            })
          ).id,
        );
      await assign(today);
    });
    afterEach(async () => {
      await db.user.deleteMany({ where: { id: { in: [client, admin] } } });
      await db.training.deleteMany({ where: { id: training } });
      await db.exercise.deleteMany({ where: { id: exercise } });
    });
    afterAll(async () => {
      await db.$disconnect();
      await pool.end();
    });

    it('separates clients, weeks and repeated circuit occurrences; exposes day/today/detail', async () => {
      const other = randomUUID();
      await db.user.create({
        data: {
          id: other,
          firebase_uid: other,
          email: `${other}@example.test`,
        },
      });
      try {
        await assign(today, other);
        const dto = body();
        dto.config = {
          sequence: [3, 2, 1, 0],
          overrides: {
            [occurrences[1]]: { mode: 'NONE' },
            [occurrences[2]]: { mode: 'FIXED', value: 0 },
          },
        };
        await service.update(actor(), client, dto);
        await service.update(actor(), other, {
          ...body(),
          starts_on: str(date(-7)),
        });
        expect(await target()).toBe(3);
        expect(await target(today, occurrences[1])).toBeNull();
        expect(await target(today, occurrences[2])).toBe(0);
        const api = new TrainingsService(
          db as unknown as PrismaService,
          new AutoAssignmentMaterializerService(
            db as unknown as PrismaService,
            new LastSetVideoPolicyService(db as unknown as PrismaService),
          ),
        );
        const day = await api.findDay(client, today);
        const detail = await api.findOne(training, client, today);
        const daily = await api.findToday(client, today);
        expect(day.trainings[0].exercises.map((e) => e.target_rir)).toEqual([
          3,
          null,
          0,
        ]);
        expect(detail.exercises.map((e) => e.target_rir)).toEqual([3, null, 0]);
        expect(JSON.stringify(daily)).toContain('"target_rir":0');
        expect(
          (await api.findDay(other, today)).trainings[0].exercises[0]
            .target_rir,
        ).toBe(2);
        expect((await api.findOne(training)).exercises[0].target_rir).toBe(8);
      } finally {
        await db.user.delete({ where: { id: other } });
      }
    });
    it('preserves operation identity, rejects stale edits and rolls back derived changes', async () => {
      const dto = body();
      expect(await service.update(actor(), client, dto)).toEqual({
        revision: 1,
      });
      expect(await service.update(actor(), client, dto)).toEqual({
        revision: 1,
      });
      await expect(
        service.update(actor(), client, {
          ...dto,
          config: { sequence: [0], overrides: {} },
        }),
      ).rejects.toThrow();
      await expect(service.update(actor(), client, body())).rejects.toThrow();
      expect(
        await db.rirCycleVersion.count({ where: { client_id: client } }),
      ).toBe(1);
      await expect(
        db.$transaction(async (tx) => {
          await lockAssignmentPlanning(tx, client);
          await tx.rirCycleVersion.create({
            data: {
              client_id: client,
              revision: 2,
              operation_id: randomUUID(),
              request: {},
              effective_from: today,
              starts_on: today,
              config: { sequence: [9], overrides: {} },
            },
          });
          throw Error('crash before commit');
        }),
      ).rejects.toThrow('crash');
      expect(await target()).toBe(3);
    });
    it('runs bulk, batch, copy-selection, copy-week and move through the actual planning service', async () => {
      const policy = new LastSetVideoPolicyService(
        db as unknown as PrismaService,
      );
      const planning = new AssignmentsService(
        db as unknown as PrismaService,
        {
          sendInternalTemplate: jest.fn().mockResolvedValue(undefined),
        } as unknown as NotificationsService,
        new AutoAssignmentMaterializerService(
          db as unknown as PrismaService,
          policy,
        ),
        policy,
      );
      await service.update(actor(), client, body());
      await planning.bulkAssign(actor(), {
        client_id: client,
        dates: [str(date(1)), str(date(2))],
        training_id: training,
      });
      await planning.batchAssign(actor(), {
        client_id: client,
        days: [{ date: str(date(7)), training_id: training }],
      });
      await planning.copySelection(actor(), {
        client_id: client,
        source_dates: [str(date(7))],
        target_start_date: str(date(14)),
      });
      await planning.copyWeek(actor(), {
        client_id: client,
        source_week_start: str(monday(date(7))),
        target_week_start: str(monday(date(21))),
      });
      const copied = await db.planAssignment.findUniqueOrThrow({
        where: { client_id_date: { client_id: client, date: date(14) } },
      });
      await planning.updateAssignment(actor(), copied.id, {
        date: str(date(28)),
      });
      for (const offset of [1, 2, 7, 21, 28])
        expect(await target(date(offset))).toBe(
          resolveRir(
            { sequence: [3, 2, 1, 0], overrides: {} },
            today,
            date(offset),
            occurrences[0],
            8,
          ),
        );
      expect(
        await db.rirCycleVersion.count({ where: { client_id: client } }),
      ).toBe(1);
    });

    it('uses destination dates for copy/move and preserves auto-rule identity across cancellation', async () => {
      await service.update(actor(), client, body());
      const next = monday(date(7));
      const a = await assign(next);
      expect(await target(next)).toBe(2);
      const moved = monday(date(14));
      await db.planAssignment.update({
        where: { id: a.id },
        data: { date: moved },
      });
      expect(await target(moved)).toBe(1);
      const rule = await db.autoAssignmentRule.create({
        data: {
          client_id: client,
          starts_on: today,
          source_week_start: monday(today),
          days: {
            create: {
              weekday: date(1).getUTCDay() || 7,
              training_id: training,
            },
          },
        },
      });
      const materializer = new AutoAssignmentMaterializerService(
        db as unknown as PrismaService,
        new LastSetVideoPolicyService(db as unknown as PrismaService),
      );
      await materializer.reconcile(client, {
        start: date(1),
        end: date(1),
        dates: [date(1)],
      });
      expect(await target(date(1))).toBe(
        resolveRir(
          { sequence: [3, 2, 1, 0], overrides: {} },
          today,
          date(1),
          occurrences[0],
          8,
        ),
      );
      await service.update(actor(), client, { ...body(1), config: null });
      expect(await target(date(1))).toBe(8);
      expect(
        (
          await db.planAssignment.findUniqueOrThrow({
            where: { client_id_date: { client_id: client, date: date(1) } },
          })
        ).auto_assignment_rule_id,
      ).toBe(rule.id);
    });
    it('protects a started date while changing other dates and preserves start when omitted', async () => {
      await service.update(actor(), client, body());
      await assign(date(1));
      await assign(date(2));
      const frozenRir = await target(date(2));
      await db.dayProgress.create({
        data: {
          client_id: client,
          date: date(2),
          meals_completed: [],
          notes: 'started',
        },
      });
      await expect(
        service.update(actor(), client, { ...body(1, 2), config: null }),
      ).rejects.toThrow();
      await service.update(actor(), client, {
        ...body(1, 1),
        starts_on: undefined,
        config: { sequence: [10], overrides: {} },
      });
      expect(await target(date(1))).toBe(10);
      expect(await target(date(2))).toBe(frozenRir);
      const view = await service.read(
        actor(),
        client,
        str(date(1)),
        str(date(2)),
      );
      expect(view.dates[1].target_rir).toBe(frozenRir);
      expect(view.dates[1].weeks).toBe(4);
      expect(
        (
          await db.rirCycleVersion.findFirstOrThrow({
            where: { client_id: client },
            orderBy: { revision: 'desc' },
          })
        ).starts_on,
      ).toEqual(monday(today));
      await db.trainingExercise.update({
        where: { id: occurrences[0] },
        data: { target_rir: 5 },
      });
      expect(await target(date(2))).toBe(frozenRir);
    });
    it('observes edit waiting for first progress and rejects after the progress commit', async () => {
      const writer = await pool.connect();
      let edit: Promise<unknown> | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query('SELECT exom_rir_lock_client($1)', [client]);
        edit = service.update(actor(), client, body());
        const result = edit.then(
          () => 'accepted',
          () => 'rejected',
        );
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          waiting = (
            await writer.query<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting",
            )
          ).rows[0].waiting;
          if (!waiting) await new Promise((r) => setTimeout(r, 10));
        }
        expect(waiting).toBe(true);
        await writer.query(
          "INSERT INTO day_progress(id,client_id,date,meals_completed,notes,updated_at) VALUES($1,$2,$3,'{}','first progress',now())",
          [randomUUID(), client, today],
        );
        await writer.query('COMMIT');
        expect(await result).toBe('rejected');
        expect(await target()).toBe(8);
      } finally {
        await writer.query('ROLLBACK');
        await edit?.catch(() => {});
        writer.release();
      }
    });
    it('keeps a day protected after progress is cleared and rejects a removed occurrence on a new cycle', async () => {
      await service.update(actor(), client, body());
      const progress = await db.dayProgress.create({
        data: {
          client_id: client,
          date: today,
          meals_completed: [],
          notes: 'started',
        },
      });
      await db.dayProgress.update({
        where: { id: progress.id },
        data: { notes: null },
      });
      await expect(
        service.update(actor(), client, { ...body(1), config: null }),
      ).rejects.toThrow();
      const before = await target();
      await db.trainingExercise.update({
        where: { id: occurrences[0] },
        data: { target_rir: 10 },
      });
      expect(await target()).toBe(before);
      await db.trainingExercise.delete({ where: { id: occurrences[2] } });
      await expect(
        service.update(actor(), client, {
          ...body(1, 1),
          config: {
            sequence: [1],
            overrides: { [occurrences[2]]: { mode: 'FIXED', value: 0 } },
          },
        }),
      ).rejects.toThrow();
    });
    it('preserves omitted proposal fields and never edits an activated cycle through the catalog', async () => {
      const api = new TrainingsService(
        db as unknown as PrismaService,
        new AutoAssignmentMaterializerService(
          db as unknown as PrismaService,
          new LastSetVideoPolicyService(db as unknown as PrismaService),
        ),
      );
      await api.update(training, { rir_proposal: [0, 10] });
      await service.update(actor(), client, body());
      await api.update(training, { name: 'Renamed by old client' });
      expect((await api.findOne(training)).rir_proposal).toEqual([0, 10]);
      await api.update(training, { rir_proposal: [10] });
      expect(await target()).toBe(3);
      expect(
        await db.rirCycleVersion.count({ where: { client_id: client } }),
      ).toBe(1);
    });
    it('materialization waits for an uncommitted cycle and uses the committed version', async () => {
      const d = date(1);
      await db.autoAssignmentRule.create({
        data: {
          client_id: client,
          starts_on: today,
          source_week_start: monday(today),
          days: {
            create: { weekday: d.getUTCDay() || 7, training_id: training },
          },
        },
      });
      const writer = await pool.connect();
      let work: Promise<void> | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query('SELECT exom_rir_lock_client($1)', [client]);
        await writer.query(
          'INSERT INTO rir_cycle_versions(client_id,revision,operation_id,request,effective_from,starts_on,config) VALUES($1,1,$2,$3,$4,$4,$5)',
          [
            client,
            randomUUID(),
            '{}',
            today,
            JSON.stringify({ sequence: [10], overrides: {} }),
          ],
        );
        const materializer = new AutoAssignmentMaterializerService(
          db as unknown as PrismaService,
          new LastSetVideoPolicyService(db as unknown as PrismaService),
        );
        work = materializer.reconcile(client, { start: d, end: d, dates: [d] });
        let waiting = false;
        for (let i = 0; i < 200 && !waiting; i++) {
          waiting = (
            await writer.query<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting",
            )
          ).rows[0].waiting;
          if (!waiting) await new Promise((r) => setTimeout(r, 10));
        }
        expect(waiting).toBe(true);
        await writer.query('COMMIT');
        await work;
        expect(await target(d)).toBe(10);
      } finally {
        await writer.query('ROLLBACK');
        await work;
        writer.release();
      }
    });
    it('validates authorization, sequence lengths and SQL resolution at year boundaries', async () => {
      await db.user.update({
        where: { id: admin },
        data: { role: Role.ADMIN },
      });
      await expect(service.update(actor(), client, body())).rejects.toThrow();
      await db.adminClientAssignment.create({
        data: { admin_id: admin, client_id: client },
      });
      await expect(
        service.update(actor(), client, {
          ...body(),
          config: {
            sequence: [0, 10],
            overrides: {
              [occurrences[0]]: { mode: 'SEQUENCE', sequence: [2] },
            },
          },
        }),
      ).rejects.toThrow();
      await service.update(actor(), client, body());
      const rows = await db.$queryRaw<Array<{ target: number }>>(
        Prisma.sql`SELECT exom_resolve_rir('{"sequence":[3,2,1,0],"overrides":{}}'::jsonb,'2026-12-30','2027-01-04','a',8) AS target`,
      );
      expect(rows[0].target).toBe(2);
    });
  },
);
