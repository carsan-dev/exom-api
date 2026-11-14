import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import { Pool } from 'pg';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  enqueueWork,
  JobsService,
  WORK_MAX_ATTEMPTS,
} from '../jobs/jobs.service';
import { BaseDeliveriesService } from './base-deliveries.service';
import { BaseDeliveryWorker } from './base-delivery.worker';
import {
  basePayloadJson,
  parseBaseDeliveryPayload,
} from './base-delivery.payload';
import { parseRecordedFiles } from './base-delivery-files';
import { measureSubscriberStamp } from './base-delivery-input';
import { BasePdfSourceProvider } from './base-pdf-source.provider';
import { StampOptions } from './base-pdf-stamp';
import { BasePdfStamper } from './base-pdf-stamper';
import {
  BASE_DELIVERY_WORK_KIND,
  baseDeliveryWorkKey,
} from './base-service.constants';
import { BaseSubscribersService } from './base-subscribers.service';

jest.mock('firebase-admin', () => ({ auth: () => ({}) }));

const url = process.env.TEST_DATABASE_URL;

const GOAL = 'perder-grasa';
const LABEL = 'Perder-grasa';
const START = 'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf';
const training = (days: number, month: number) =>
  `entrenamiento/${GOAL}/EXOM_Entrenamiento_${LABEL}_${days}-dias_Bloque-0${month}.pdf`;
const guide = (month: number) =>
  `nutricion/${GOAL}/EXOM_Nutricion_${LABEL}_Guia-0${month}.pdf`;

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real stamper whose output can be switched, as a library/font upgrade would. */
class SwitchableStamper extends BasePdfStamper {
  variant: string | null = null;
  stamp(source: Uint8Array, options: StampOptions): Promise<Uint8Array> {
    return super.stamp(
      source,
      this.variant
        ? { ...options, keywords: `${options.keywords};${this.variant}` }
        : options,
    );
  }
}

async function samplePdf(title: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.addPage([400, 600]).drawText(title.slice(-24), { x: 20, y: 300 });
  doc.addPage([400, 600]);
  return Buffer.from(await doc.save());
}

function httpErrorOf(error: unknown) {
  if (!(error instanceof HttpException)) throw error;
  const body = error.getResponse();
  const fields: Record<string, unknown> =
    typeof body === 'object' && body !== null
      ? Object.fromEntries(Object.entries(body))
      : {};
  return {
    status: error.getStatus(),
    code: fields.code,
    message: typeof fields.message === 'string' ? fields.message : '',
  };
}

async function httpError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return httpErrorOf(error);
  }
  throw new Error('Expected an HTTP error');
}

interface SentRequest {
  key: string | null;
  body: string;
  json: {
    to: string;
    from: string;
    subject: string;
    text: string;
    attachments: { filename: string; content: string }[];
  };
}

function parseSent(body: string): SentRequest['json'] {
  const value: unknown = JSON.parse(body);
  if (typeof value !== 'object' || value === null)
    throw Error('Expected object');
  const fields = Object.fromEntries(Object.entries(value));
  const text = (key: string) => {
    const field: unknown = fields[key];
    if (typeof field !== 'string') throw Error('Expected ' + key);
    return field;
  };
  const list: unknown = fields.attachments;
  const attachments = Array.isArray(list)
    ? list.map((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null)
          throw Error('attachment');
        const item = Object.fromEntries(Object.entries(entry));
        if (
          typeof item.filename !== 'string' ||
          typeof item.content !== 'string'
        )
          throw Error('attachment');
        return { filename: item.filename, content: item.content };
      })
    : [];
  return {
    to: text('to'),
    from: text('from'),
    subject: text('subject'),
    text: text('text'),
    attachments,
  };
}

(url ? describe : describe.skip)(
  'Servicio base (PostgreSQL / simulated provider and catalogue)',
  () => {
    let pool: Pool;
    let db: PrismaClient;
    let jobs: JobsService;
    let subscribers: BaseSubscribersService;
    let deliveries: BaseDeliveriesService;
    let catalogue: string;
    let isolated = false;
    let fetchMock: jest.SpiedFunction<typeof fetch>;
    let sent: SentRequest[];
    let emailSeq = 0;
    const tag = `bs-${process.pid}-${Date.now()}`;
    const admin = { id: `${tag}-admin`, role: Role.ADMIN };
    const superAdmin = { id: `${tag}-super`, role: Role.SUPER_ADMIN };
    const client = { id: `${tag}-client`, role: Role.CLIENT };
    const originals = new Map<string, Buffer>();
    const stamper = new SwitchableStamper();

    const accept = (id: string) =>
      new Response(JSON.stringify({ id }), { status: 200 });
    function record(init: RequestInit | undefined) {
      if (typeof init?.body !== 'string') throw Error('Expected JSON body');
      sent.push({
        key: new Headers(init.headers).get('Idempotency-Key'),
        body: init.body,
        json: parseSent(init.body),
      });
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: url, max: 12 });
      await assertTestDatabase(pool);
      isolated = true;
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      Object.assign(db, { postgresqlPool: pool });
      await db.user.createMany({
        data: [admin, superAdmin, client].map((user) => ({
          id: user.id,
          firebase_uid: user.id,
          email: `${user.id}@example.test`,
          role: user.role,
        })),
      });
      catalogue = mkdtempSync(join(tmpdir(), 'exom-base-catalogue-'));
      const keys = [START];
      for (const month of [1, 2]) {
        keys.push(training(3, month), training(4, month), guide(month));
      }
      for (const key of keys) {
        const bytes = await samplePdf(key);
        originals.set(key, bytes);
        mkdirSync(dirname(join(catalogue, key)), { recursive: true });
        writeFileSync(join(catalogue, key), bytes);
      }
      const config = new ConfigService({
        NODE_ENV: 'test',
        BASE_PDF_LOCAL_DIR: catalogue,
        RESEND_API_KEY: 'test-only',
        RESEND_FROM_EMAIL: 'EXOM <sender@example.test>',
        SUPPORT_URL: 'https://exommethod.com/support',
      });
      const prisma = db as PrismaService;
      jobs = new JobsService(prisma);
      const email = new EmailService(config, prisma, jobs);
      const sources = new BasePdfSourceProvider(config);
      subscribers = new BaseSubscribersService(prisma, sources);
      deliveries = new BaseDeliveriesService(prisma, sources, email, stamper);
      new BaseDeliveryWorker(
        prisma,
        jobs,
        email,
        sources,
        config,
        stamper,
      ).onModuleInit();
    });

    beforeEach(() => {
      sent = [];
      fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(accept(`msg-${sent.length}`));
        });
    });
    afterEach(() => {
      fetchMock.mockRestore();
      stamper.variant = null;
    });

    afterAll(async () => {
      if (isolated) {
        const ids = (
          await db.baseSubscriber.findMany({
            where: { created_by_id: { in: [admin.id, superAdmin.id] } },
            select: { id: true, deliveries: { select: { id: true } } },
          })
        ).flatMap((row) => row.deliveries.map((delivery) => delivery.id));
        await db.durableWork.deleteMany({
          where: {
            OR: ids.map((id) => ({
              key: { startsWith: `base-delivery:${id}:` },
            })),
          },
        });
        await db.baseDelivery.deleteMany({ where: { id: { in: ids } } });
        await db.baseSubscriber.deleteMany({
          where: { created_by_id: { in: [admin.id, superAdmin.id] } },
        });
        await db.user.deleteMany({
          where: { id: { in: [admin.id, superAdmin.id, client.id] } },
        });
      }
      if (catalogue) rmSync(catalogue, { recursive: true, force: true });
      await db?.$disconnect();
      await pool?.end();
    });

    const uniqueEmail = () => `${tag}-${++emailSeq}@example.test`;
    const newSubscriber = (
      overrides: Partial<{ name: string; days: number }> = {},
    ) =>
      subscribers.create(
        {
          name: overrides.name ?? '  Ana   Pérez ',
          email: uniqueEmail(),
          goal: GOAL,
          days_per_week: overrides.days ?? 3,
        },
        admin,
      );
    const work = (key: string) =>
      db.durableWork.findUniqueOrThrow({ where: { key } });
    const due = (key: string) =>
      db.durableWork.update({
        where: { key },
        data: { next_attempt_at: new Date(0) },
      });
    const delivery = (id: string) =>
      db.baseDelivery.findUniqueOrThrow({ where: { id } });
    const doneFields = (payload: unknown): Record<string, unknown> => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw Error('payload');
      return Object.fromEntries(Object.entries(payload));
    };
    const latest = async (subscriberId: string, deliveryId: string) => {
      const found = (await deliveries.list(subscriberId)).find(
        (entry) => entry.id === deliveryId,
      );
      if (!found) throw Error('delivery not listed');
      return found;
    };
    const timeoutOnce = () =>
      fetchMock.mockImplementation((_url, init) => {
        record(init);
        return sent.length === 1
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve(accept(`msg-${sent.length}`));
      });

    describe('subscribers', () => {
      it('creates with a generated order code, normalised name and lower-case email', async () => {
        const email = uniqueEmail().toUpperCase();
        const created = await subscribers.create(
          { name: ' Ana   Pérez ', email, goal: GOAL, days_per_week: 4 },
          admin,
        );
        expect(created.order_code).toMatch(/^EXB-\d{6,}$/);
        expect(created).toMatchObject({
          name: 'Ana Pérez',
          email: email.toLowerCase(),
          is_archived: false,
          archived_at: null,
          created_by_id: admin.id,
          last_sent_month: null,
          next_month: 1,
          latest_delivery: null,
        });
      });

      it('rejects names the stamp cannot print and routes the catalogue lacks', async () => {
        const base = { email: uniqueEmail(), goal: GOAL, days_per_week: 3 };
        expect(
          await httpError(
            subscribers.create({ ...base, name: 'Ana\u0007' }, admin),
          ),
        ).toMatchObject({ status: 400, code: 'INVALID_NAME' });
        expect(
          await httpError(
            subscribers.create({ ...base, name: 'Ana 漢字' }, admin),
          ),
        ).toMatchObject({ status: 400, code: 'INVALID_NAME' });
        expect(
          await httpError(
            subscribers.create(
              { ...base, name: 'Ana', goal: 'ganar-musculo' },
              admin,
            ),
          ),
        ).toMatchObject({ status: 400, code: 'INVALID_GOAL' });
        expect(
          await httpError(
            subscribers.create(
              { ...base, name: 'Ana', days_per_week: 5 },
              admin,
            ),
          ),
        ).toMatchObject({ status: 400, code: 'INVALID_DAYS' });
        expect(
          await httpError(
            subscribers.create(
              { ...base, name: 'Ana', email: 'ana漢@example.test' },
              admin,
            ),
          ),
        ).toMatchObject({ status: 400, code: 'INVALID_EMAIL' });
      });

      it('keeps emails unique case-insensitively among non-archived subscribers', async () => {
        const first = await newSubscriber();
        const clash = {
          name: 'Otra',
          email: first.email.toUpperCase(),
          goal: GOAL,
          days_per_week: 3,
        };
        expect(await httpError(subscribers.create(clash, admin))).toMatchObject(
          {
            status: 409,
            code: 'EMAIL_TAKEN',
          },
        );
        await subscribers.setArchived(first.id, true, admin);
        const second = await subscribers.create(clash, superAdmin);
        expect(second.order_code).not.toBe(first.order_code);
        // Restoring the archived one would create two live rows: refused.
        expect(
          await httpError(subscribers.setArchived(first.id, false, admin)),
        ).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
        // The partial unique index is the backstop for writers that skip checks.
        await expect(
          pool.query(
            `INSERT INTO base_subscribers (id, name, email, goal, days_per_week, updated_at)
             VALUES ($1, 'X', $2, $3, 3, now())`,
            [`${tag}-raw`, second.email, GOAL],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });

      it('rejects a client caller and a role that changed since the guard ran', async () => {
        expect(await httpError(newSubscriberAs(client))).toMatchObject({
          status: 403,
          code: 'STAFF_ACCESS_REQUIRED',
        });
        expect(
          await httpError(
            newSubscriberAs({ id: admin.id, role: Role.SUPER_ADMIN }),
          ),
        ).toMatchObject({ status: 403, code: 'STAFF_ACCESS_CHANGED' });
      });
      function newSubscriberAs(actor: { id: string; role: string }) {
        return subscribers.create(
          { name: 'Ana', email: uniqueEmail(), goal: GOAL, days_per_week: 3 },
          actor,
        );
      }

      it('generates distinct order codes under concurrent creation', async () => {
        const created = await Promise.all(
          Array.from({ length: 12 }, () => newSubscriber()),
        );
        const codes = created.map((row) => row.order_code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const code of codes) expect(code).toMatch(/^EXB-\d{6,}$/);
      });

      it('never lets the order code change', async () => {
        const row = await newSubscriber();
        await expect(
          pool.query(
            `UPDATE base_subscribers SET order_code = 'EXB-999999' WHERE id = $1`,
            [row.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      });

      it('searches by name, email or order code and filters archived', async () => {
        const row = await newSubscriber({ name: 'Zoë Búsqueda' });
        const byName = await subscribers.list({
          q: 'zoe busq',
          page: 1,
          limit: 20,
        });
        expect(byName.data.map((item) => item.id)).toContain(row.id);
        const byCode = await subscribers.list({
          q: row.order_code.toLowerCase(),
          page: 1,
          limit: 20,
        });
        expect(byCode.data.map((item) => item.id)).toEqual([row.id]);
        await subscribers.setArchived(row.id, true, admin);
        const visible = await subscribers.list({
          q: row.order_code,
          page: 1,
          limit: 20,
        });
        expect(visible.total).toBe(0);
        const archived = await subscribers.list({
          q: row.order_code,
          archive: 'archived',
          page: 1,
          limit: 20,
        });
        expect(archived.data[0]).toMatchObject({
          id: row.id,
          is_archived: true,
        });
        expect(archived.data[0].archived_at).toBeInstanceOf(Date);
      });
    });

    describe('stamp length (name + email must fit the license line)', () => {
      const longName = 'A'.repeat(80);
      /** Unique valid address of exactly `length` characters. */
      const emailOfLength = (prefix: string, length: number) => {
        const local = (prefix + 'a'.repeat(64)).slice(
          0,
          Math.min(64, length - 6),
        );
        let rest = length - local.length - 1 - '.com'.length;
        const labels: string[] = [];
        while (rest > 63) {
          labels.push('b'.repeat(62));
          rest -= 63;
        }
        labels.push('b'.repeat(rest));
        return `${local}@${labels.join('.')}.com`;
      };
      /** Measured boundary for `name`: the last fitting and first overflowing email. */
      const boundary = (name: string) => {
        const prefix = `${tag}-${++emailSeq}-`;
        let length = prefix.length + 8;
        while (measureSubscriberStamp(name, emailOfLength(prefix, length)).fits)
          length += 1;
        return {
          fitting: emailOfLength(prefix, length - 1),
          overflowing: emailOfLength(prefix, length),
        };
      };

      it('create and update reject the combination one character past the measured limit', async () => {
        const { fitting, overflowing } = boundary(longName);
        const tooLong = await httpError(
          subscribers.create(
            {
              name: longName,
              email: overflowing,
              goal: GOAL,
              days_per_week: 3,
            },
            admin,
          ),
        );
        expect(tooLong).toMatchObject({ status: 400, code: 'STAMP_TOO_LONG' });
        expect(tooLong.message).toContain('nombre y el email');
        expect(
          await db.baseSubscriber.count({ where: { email: overflowing } }),
        ).toBe(0);

        const stored = await subscribers.create(
          { name: longName, email: fitting, goal: GOAL, days_per_week: 3 },
          admin,
        );
        expect(stored).toMatchObject({ name: longName, email: fitting });
        // Email alone, validated against the stored name.
        expect(
          await httpError(
            subscribers.update(stored.id, { email: overflowing }, admin),
          ),
        ).toMatchObject({ status: 400, code: 'STAMP_TOO_LONG' });

        // Name alone, validated against the stored email.
        const short = await subscribers.create(
          { name: 'Ana', email: overflowing, goal: GOAL, days_per_week: 3 },
          admin,
        );
        expect(
          await httpError(
            subscribers.update(short.id, { name: longName }, admin),
          ),
        ).toMatchObject({ status: 400, code: 'STAMP_TOO_LONG' });
        expect(await subscribers.get(short.id)).toMatchObject({
          name: 'Ana',
          email: overflowing,
        });
        expect(await subscribers.get(stored.id)).toMatchObject({
          email: fitting,
        });
        // Unrelated edits of a fitting row are unaffected.
        expect(
          (await subscribers.update(stored.id, { notes: 'ok' }, admin)).notes,
        ).toBe('ok');
      });

      it('delivery creation refuses a stored (legacy) row whose stamp cannot fit', async () => {
        const s = await newSubscriber();
        const { overflowing } = boundary(longName);
        // A row written before the rule (or by a writer that skipped it).
        await pool.query(
          'UPDATE base_subscribers SET name = $2, email = $3 WHERE id = $1',
          [s.id, longName, overflowing],
        );
        const refused = await httpError(deliveries.create(s.id, 1, admin));
        expect(refused).toMatchObject({ status: 409, code: 'STAMP_TOO_LONG' });
        expect(
          await db.baseDelivery.count({ where: { subscriber_id: s.id } }),
        ).toBe(0);
      });

      it('the email job fails an unstampable snapshot permanently, sending nothing', async () => {
        const s = await newSubscriber();
        const { overflowing } = boundary(longName);
        const id = `${tag}-unstampable`;
        const files = [
          {
            filename: 'x.pdf',
            source_key: training(3, 1),
            source_sha256: '0',
            sha256: '0',
            size: 1,
          },
        ];
        await pool.query(
          `INSERT INTO base_deliveries (id, subscriber_id, month, snapshot_name, snapshot_email,
             snapshot_goal, snapshot_days_per_week, snapshot_order_code, files, updated_at)
           VALUES ($1, $2, 1, $3, $4, $5, 3, $6, $7::jsonb, now())`,
          [
            id,
            s.id,
            longName,
            overflowing,
            GOAL,
            s.order_code,
            JSON.stringify(files),
          ],
        );
        const key = baseDeliveryWorkKey(id, 1);
        await enqueueWork(
          db,
          key,
          BASE_DELIVERY_WORK_KIND,
          basePayloadJson({
            deliveryId: id,
            sendSeq: 1,
            requestedById: admin.id,
            requestedAt: new Date().toISOString(),
            name: longName,
            email: overflowing,
            files,
          }),
        );
        await jobs.runKey(key);
        expect(sent).toHaveLength(0);
        expect(await delivery(id)).toMatchObject({
          status: 'FAILED',
          last_error: 'BASE_STAMP_TOO_LONG',
        });
        expect(await work(key)).toMatchObject({
          status: 'FAILED',
          last_error: 'BASE_STAMP_TOO_LONG',
          attempts: 1,
        });
      });

      it('a resend whose CURRENT name + email cannot fit is refused (STAMP_TOO_LONG) and changes nothing', async () => {
        const { overflowing } = boundary(longName);
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        expect((await delivery(d.id)).status).toBe('SENT');
        // A row written by a writer that skipped the rule.
        await pool.query(
          'UPDATE base_subscribers SET name = $2, email = $3 WHERE id = $1',
          [s.id, longName, overflowing],
        );
        const before = await delivery(d.id);
        expect(
          await httpError(deliveries.resend(s.id, d.id, admin)),
        ).toMatchObject({ status: 409, code: 'STAMP_TOO_LONG' });
        expect(await delivery(d.id)).toEqual(before);
        expect(
          await db.durableWork.count({
            where: { key: { startsWith: `base-delivery:${d.id}:` } },
          }),
        ).toBe(1);
        expect(sent).toHaveLength(1);
      });
    });

    describe('deliveries', () => {
      it('only accepts the next month and records the exact package', async () => {
        const s = await newSubscriber();
        expect(
          await httpError(deliveries.create(s.id, 2, admin)),
        ).toMatchObject({
          status: 409,
          code: 'MONTH_NOT_NEXT',
          message: 'Solo se puede enviar el mes 1 a este suscriptor.',
        });
        const d = await deliveries.create(s.id, 1, admin);
        expect(d).toMatchObject({
          month: 1,
          status: 'PENDING',
          send_seq: 1,
          snapshot_name: 'Ana Pérez',
          snapshot_email: s.email,
          snapshot_goal: GOAL,
          snapshot_days_per_week: 3,
          snapshot_order_code: s.order_code,
          requested_by_id: admin.id,
          sends: [
            { send_seq: 1, status: 'PENDING', requested_by_id: admin.id },
          ],
        });
        expect(d.files.map((file) => file.source_key)).toEqual([
          training(3, 1),
          guide(1),
          START,
        ]);
        for (const file of d.files)
          expect(file.source_sha256).toBe(sha(originals.get(file.source_key)!));
        expect(await work(baseDeliveryWorkKey(d.id, 1))).toMatchObject({
          kind: 'BASE_DELIVERY_EMAIL',
          status: 'PENDING',
          owner_id: null,
        });
        expect(
          await httpError(deliveries.create(s.id, 1, admin)),
        ).toMatchObject({
          status: 409,
          code: 'DELIVERY_EXISTS',
        });
        expect(
          await httpError(deliveries.create(s.id, 3, admin)),
        ).toMatchObject({
          status: 409,
          code: 'MONTH_NOT_NEXT',
        });
        // Month 2 waits until month 1 has actually been sent.
        expect(
          await httpError(deliveries.create(s.id, 2, superAdmin)),
        ).toMatchObject({
          status: 409,
          code: 'PREVIOUS_MONTH_NOT_SENT',
          message:
            'No se puede enviar el mes 2: el mes 1 todavía está pendiente de envío. Espera a que termine su envío antes de enviar el mes 2.',
        });
        await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        const d2 = await deliveries.create(s.id, 2, superAdmin);
        expect(d2.files.map((file) => file.source_key)).toEqual([
          training(3, 2),
          guide(2),
        ]);
        await jobs.runKey(baseDeliveryWorkKey(d2.id, 1));
        const noContent = await httpError(deliveries.create(s.id, 3, admin));
        expect(noContent).toMatchObject({
          status: 409,
          code: 'NO_CONTENT_FOR_MONTH',
        });
        expect(noContent.message).toContain('Meses disponibles: 1, 2');
        expect(await subscribers.get(s.id)).toMatchObject({
          next_month: 3,
          last_sent_month: 2,
          latest_delivery: { id: d2.id, month: 2, status: 'SENT' },
        });
      });

      it('refuses month N while month N-1 FAILED, and accepts it once a resend is SENT', async () => {
        const s = await newSubscriber();
        const d1 = await deliveries.create(s.id, 1, admin);
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(
            new Response(JSON.stringify({ name: 'validation_error' }), {
              status: 422,
            }),
          );
        });
        await jobs.runKey(baseDeliveryWorkKey(d1.id, 1));
        expect((await delivery(d1.id)).status).toBe('FAILED');
        expect(
          await httpError(deliveries.create(s.id, 2, admin)),
        ).toMatchObject({
          status: 409,
          code: 'PREVIOUS_MONTH_NOT_SENT',
          message:
            'No se puede enviar el mes 2: el envío del mes 1 ha fallado. Reenvía el mes 1 primero y, cuando conste como enviado, envía el mes 2.',
        });
        // The resend is PENDING: still refused; once accepted, allowed.
        await deliveries.resend(s.id, d1.id, admin);
        expect(
          await httpError(deliveries.create(s.id, 2, admin)),
        ).toMatchObject({ status: 409, code: 'PREVIOUS_MONTH_NOT_SENT' });
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(accept('msg-resent'));
        });
        await jobs.runKey(baseDeliveryWorkKey(d1.id, 2));
        expect((await delivery(d1.id)).status).toBe('SENT');
        expect((await deliveries.create(s.id, 2, admin)).month).toBe(2);
        expect(
          await db.baseDelivery.count({ where: { subscriber_id: s.id } }),
        ).toBe(2);
      });

      it('re-reads month N-1 under the subscriber lock (a resend committed meanwhile wins)', async () => {
        const s = await newSubscriber();
        const d1 = await deliveries.create(s.id, 1, admin);
        await jobs.runKey(baseDeliveryWorkKey(d1.id, 1));
        expect((await delivery(d1.id)).status).toBe('SENT');
        const holder = await pool.connect();
        let result: PromiseSettledResult<unknown>[] = [];
        try {
          // Same writes as a resend, under the same subscriber row lock; the
          // request passes its unlocked pre-check (month 1 still SENT for it)
          // and must see the committed PENDING once it gets the lock.
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM base_subscribers WHERE id = $1 FOR UPDATE',
            [s.id],
          );
          await holder.query(
            `UPDATE base_deliveries SET status = 'PENDING', send_seq = send_seq + 1,
               last_error = NULL WHERE id = $1`,
            [d1.id],
          );
          const racing = Promise.allSettled([
            deliveries.create(s.id, 2, admin),
          ]);
          const holderPid = (
            await holder.query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            )
          ).rows[0].pid;
          for (let attempt = 0; ; attempt++) {
            const { rows } = await pool.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> $2`,
              ['%FROM base_subscribers WHERE id = $1 FOR UPDATE%', holderPid],
            );
            if (rows[0].n === 1) break;
            if (attempt > 300) throw Error('Request never reached the lock');
            await sleep(50);
          }
          await holder.query('COMMIT');
          result = await racing;
        } finally {
          holder.release();
        }
        const rejected = result.filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        expect(httpErrorOf(rejected[0].reason)).toMatchObject({
          status: 409,
          code: 'PREVIOUS_MONTH_NOT_SENT',
        });
        expect(
          await db.baseDelivery.count({ where: { subscriber_id: s.id } }),
        ).toBe(1);
      });

      it('refuses deliveries for archived subscribers', async () => {
        const s = await newSubscriber();
        await subscribers.setArchived(s.id, true, admin);
        expect(
          await httpError(deliveries.create(s.id, 1, admin)),
        ).toMatchObject({
          status: 409,
          code: 'SUBSCRIBER_ARCHIVED',
        });
        expect(
          await db.baseDelivery.count({ where: { subscriber_id: s.id } }),
        ).toBe(0);
      });

      it('keeps the request snapshot when the subscriber is edited later', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        await subscribers.update(
          s.id,
          { name: 'Ana Nueva', email: uniqueEmail(), days_per_week: 4 },
          admin,
        );
        expect(await delivery(d.id)).toMatchObject({
          snapshot_name: 'Ana Pérez',
          snapshot_email: s.email,
          snapshot_days_per_week: 3,
        });
        await expect(
          pool.query(
            `UPDATE base_deliveries SET snapshot_name = 'X' WHERE id = $1`,
            [d.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        // The next month uses the edited data.
        await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        const d2 = await deliveries.create(s.id, 2, admin);
        expect(d2).toMatchObject({
          snapshot_name: 'Ana Nueva',
          snapshot_days_per_week: 4,
        });
        expect(d2.files[0].source_key).toBe(training(4, 2));
      });

      it('enforces one delivery per (subscriber, month) in the database', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const row = await delivery(d.id);
        await expect(
          pool.query(
            `INSERT INTO base_deliveries (id, subscriber_id, month, snapshot_name, snapshot_email,
               snapshot_goal, snapshot_days_per_week, snapshot_order_code, files, updated_at)
             SELECT $1, subscriber_id, month, snapshot_name, snapshot_email, snapshot_goal,
               snapshot_days_per_week, snapshot_order_code, files, now()
             FROM base_deliveries WHERE id = $2`,
            [`${tag}-dup`, row.id],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      });

      it('two interleaved "send month 1" requests yield exactly one delivery and one email intent', async () => {
        const s = await newSubscriber();
        const holder = await pool.connect();
        let results: PromiseSettledResult<unknown>[] = [];
        try {
          // Both requests pass their unlocked pre-checks and package build,
          // then queue on the subscriber row lock held here.
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM base_subscribers WHERE id = $1 FOR UPDATE',
            [s.id],
          );
          const racing = Promise.allSettled([
            deliveries.create(s.id, 1, admin),
            deliveries.create(s.id, 1, superAdmin),
          ]);
          for (let attempt = 0; ; attempt++) {
            const { rows } = await pool.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> $2`,
              [
                '%FROM base_subscribers WHERE id = $1 FOR UPDATE%',
                (
                  await holder.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0].pid,
              ],
            );
            if (rows[0].n === 2) break;
            if (attempt > 300) throw Error('Requests never reached the lock');
            await sleep(50);
          }
          await holder.query('COMMIT');
          results = await racing;
        } finally {
          holder.release();
        }
        const fulfilled = results.filter(
          (result) => result.status === 'fulfilled',
        );
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(httpErrorOf(rejected[0].reason)).toMatchObject({
          status: 409,
          code: 'DELIVERY_EXISTS',
        });
        const rows = await db.baseDelivery.findMany({
          where: { subscriber_id: s.id },
        });
        expect(rows).toHaveLength(1);
        expect(
          await db.durableWork.count({
            where: { key: { startsWith: `base-delivery:${rows[0].id}:` } },
          }),
        ).toBe(1);
        await jobs.runKey(baseDeliveryWorkKey(rows[0].id, 1));
        expect(sent).toHaveLength(1);
      });
    });

    describe('delivery email job', () => {
      it('sends one email with the stamped PDFs and marks SENT with the provider id', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        await jobs.runKey(key);
        expect(sent).toHaveLength(1);
        const [request] = sent;
        expect(request.key).toBe(key);
        expect(request.json).toMatchObject({
          to: s.email,
          from: 'EXOM <sender@example.test>',
          subject: 'EXOM · Tu material del mes 1',
        });
        expect(request.json.text).toContain('Hola Ana:');
        expect(request.json.text).toContain('Guía de inicio');
        const recorded = parseRecordedFiles((await delivery(d.id)).files)!;
        expect(request.json.attachments.map((file) => file.filename)).toEqual(
          recorded.map((file) => file.filename),
        );
        request.json.attachments.forEach((attachment, index) => {
          const bytes = Buffer.from(attachment.content, 'base64');
          // Stamped bytes exactly as recorded, built from the recorded source.
          expect(sha(bytes)).toBe(recorded[index].sha256);
          expect(bytes.byteLength).toBe(recorded[index].size);
          expect(sha(originals.get(recorded[index].source_key)!)).toBe(
            recorded[index].source_sha256,
          );
          expect(bytes.equals(originals.get(recorded[index].source_key)!)).toBe(
            false,
          );
        });
        const stamped = await PDFDocument.load(
          Buffer.from(request.json.attachments[0].content, 'base64'),
          { updateMetadata: false },
        );
        expect(stamped.getKeywords()).toBe(`EXOM;${s.order_code}`);
        // Stamped with the SNAPSHOT email the package is sent to.
        expect(stamped.getSubject()).toBe(
          `Licencia personal de Ana Pérez (${s.email}) · Pedido ${s.order_code}`,
        );
        expect(await delivery(d.id)).toMatchObject({
          status: 'SENT',
          provider_message_id: 'msg-1',
          last_error: null,
        });
        const done = await work(key);
        expect(done).toMatchObject({
          status: 'DONE',
          payload: { accepted: true, providerMessageId: 'msg-1', sendSeq: 1 },
        });
        // The request body kept for retries is dropped after acceptance; the
        // send keeps only its recipient (history), in `name`/`email`.
        expect(done.payload).not.toHaveProperty('request');
        expect(done.payload).toMatchObject({
          name: 'Ana Pérez',
          email: s.email,
          handoffs: 1,
          lastHandoffAttempt: 1,
        });
        expect(
          JSON.stringify({ ...doneFields(done.payload), email: null }),
        ).not.toContain(s.email);
        expect(await subscribers.get(s.id)).toMatchObject({
          last_sent_month: 1,
        });
      });

      it('does not send when the subscriber was archived meanwhile', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        await subscribers.setArchived(s.id, true, admin);
        await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        expect(sent).toHaveLength(0);
        expect(await delivery(d.id)).toMatchObject({
          status: 'FAILED',
          last_error: 'SUBSCRIBER_ARCHIVED',
        });
        expect(await work(baseDeliveryWorkKey(d.id, 1))).toMatchObject({
          status: 'FAILED',
          last_error: 'SUBSCRIBER_ARCHIVED',
        });
        // Provably pre-send: no provider call was ever started.
        expect(await latest(s.id, d.id)).toMatchObject({
          possibly_delivered: false,
          sends: [
            {
              status: 'FAILED',
              error: 'SUBSCRIBER_ARCHIVED',
              possibly_delivered: false,
            },
          ],
        });
        expect(
          await httpError(deliveries.resend(s.id, d.id, admin)),
        ).toMatchObject({ status: 409, code: 'SUBSCRIBER_ARCHIVED' });
      });

      it('retries a transient failure with the same key and the same body', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(
            sent.length === 1
              ? new Response(
                  JSON.stringify({ name: 'internal_server_error' }),
                  {
                    status: 500,
                  },
                )
              : accept('msg-after-retry'),
          );
        });
        await jobs.runKey(key);
        expect(await work(key)).toMatchObject({
          status: 'PENDING',
          last_error: 'EMAIL_PROVIDER_UNAVAILABLE',
        });
        expect((await delivery(d.id)).status).toBe('PENDING');
        expect((await deliveries.list(s.id))[0].sends[0]).toMatchObject({
          status: 'PENDING',
          error: 'EMAIL_PROVIDER_UNAVAILABLE',
          attempts: 1,
        });
        await due(key);
        await jobs.runKey(key);
        expect(sent).toHaveLength(2);
        expect(sent[1].key).toBe(sent[0].key);
        expect(sent[1].body).toBe(sent[0].body);
        expect(await delivery(d.id)).toMatchObject({
          status: 'SENT',
          provider_message_id: 'msg-after-retry',
        });
      });

      it('a lost provider response is retried under the same key and body (provider dedupes)', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          if (sent.length === 1)
            return Promise.reject(new Error('socket hang up'));
          return Promise.resolve(accept('msg-original'));
        });
        await jobs.runKey(key);
        expect((await work(key)).last_error).toBe('EMAIL_PROVIDER_UNREACHABLE');
        await due(key);
        await jobs.runKey(key);
        expect(sent.map((request) => request.key)).toEqual([key, key]);
        expect(sent[1].body).toBe(sent[0].body);
        expect((await delivery(d.id)).provider_message_id).toBe('msg-original');
      });

      it('marks a permanent provider rejection FAILED without retrying', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(
            new Response(
              JSON.stringify({ name: 'validation_error', message: s.email }),
              {
                status: 422,
              },
            ),
          );
        });
        await jobs.runKey(key);
        expect(sent).toHaveLength(1);
        expect(await delivery(d.id)).toMatchObject({
          status: 'FAILED',
          last_error: 'EMAIL_REQUEST_REJECTED',
        });
        expect(await work(key)).toMatchObject({
          status: 'FAILED',
          last_error: 'EMAIL_REQUEST_REJECTED',
        });
        // The only call was refused: nothing was sent.
        expect((await latest(s.id, d.id)).possibly_delivered).toBe(false);
        // A FAILED delivery can be retried explicitly with a new key.
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(accept('msg-resent'));
        });
        const resent = await deliveries.resend(s.id, d.id, superAdmin);
        expect(resent).toMatchObject({
          status: 'PENDING',
          send_seq: 2,
          last_error: null,
        });
        await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
        expect(sent[1].key).toBe(baseDeliveryWorkKey(d.id, 2));
        expect(await delivery(d.id)).toMatchObject({
          status: 'SENT',
          provider_message_id: 'msg-resent',
        });
      });

      it('a deliberate resend of a SENT delivery uses a new key and stays in the history', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        expect(
          await httpError(deliveries.create(s.id, 1, admin)),
        ).toMatchObject({ code: 'DELIVERY_EXISTS' });
        const resent = await deliveries.resend(s.id, d.id, superAdmin);
        expect(resent.send_seq).toBe(2);
        expect(
          await httpError(deliveries.resend(s.id, d.id, admin)),
        ).toMatchObject({ status: 409, code: 'DELIVERY_PENDING' });
        await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
        expect(sent.map((request) => request.key)).toEqual([
          baseDeliveryWorkKey(d.id, 1),
          baseDeliveryWorkKey(d.id, 2),
        ]);
        // Same snapshot and stamped files, different provider idempotency key.
        expect(sent[1].json.attachments).toEqual(sent[0].json.attachments);
        const [history] = await deliveries.list(s.id);
        expect(history).toMatchObject({
          status: 'SENT',
          send_seq: 2,
          provider_message_id: 'msg-2',
        });
        expect(history.sends).toEqual([
          expect.objectContaining({
            send_seq: 1,
            status: 'SENT',
            requested_by_id: admin.id,
            provider_message_id: 'msg-1',
          }),
          expect.objectContaining({
            send_seq: 2,
            status: 'SENT',
            requested_by_id: superAdmin.id,
            provider_message_id: 'msg-2',
          }),
        ]);
      });

      it('fails visibly when a source PDF is missing or changed at send time', async () => {
        const missing = await newSubscriber({ days: 4 });
        const changed = await newSubscriber({ days: 4 });
        const d1 = await deliveries.create(missing.id, 1, admin);
        const d2 = await deliveries.create(changed.id, 1, admin);
        const path = join(catalogue, guide(1));
        try {
          rmSync(path);
          await jobs.runKey(baseDeliveryWorkKey(d1.id, 1));
          expect(await delivery(d1.id)).toMatchObject({
            status: 'FAILED',
            // Selection runs on the listing: a removed file means no content.
            last_error: 'BASE_CONTENT_UNAVAILABLE',
          });
          writeFileSync(path, await samplePdf('corrected guide'));
          await jobs.runKey(baseDeliveryWorkKey(d2.id, 1));
          expect(await delivery(d2.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'BASE_SOURCE_CHANGED',
          });
        } finally {
          writeFileSync(path, originals.get(guide(1))!);
        }
        expect(sent).toHaveLength(0);
        // Provably pre-send: reported as nothing sent.
        expect((await latest(missing.id, d1.id)).possibly_delivered).toBe(
          false,
        );
        expect((await latest(changed.id, d2.id)).possibly_delivered).toBe(
          false,
        );
      });

      it('stops before sending once the provider idempotency window may have expired', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.reject(new Error('timeout'));
        });
        await jobs.runKey(key);
        const prepared = await work(key);
        const payload = prepared.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw Error('payload');
        await db.durableWork.update({
          where: { key },
          data: {
            next_attempt_at: new Date(0),
            payload: {
              ...payload,
              preparedAt: new Date(Date.now() - 24 * 3600000).toISOString(),
            },
          },
        });
        await jobs.runKey(key);
        expect(sent).toHaveLength(1);
        expect(await delivery(d.id)).toMatchObject({
          status: 'FAILED',
          last_error: 'EMAIL_DEDUP_WINDOW_EXPIRED',
        });
        expect((await latest(s.id, d.id)).possibly_delivered).toBe(true);
      });

      it('marks the delivery FAILED when the attempt budget is exhausted', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        const key = baseDeliveryWorkKey(d.id, 1);
        await db.durableWork.update({
          where: { key },
          data: { attempts: WORK_MAX_ATTEMPTS - 1 },
        });
        fetchMock.mockImplementation((_url, init) => {
          record(init);
          return Promise.resolve(new Response('{}', { status: 503 }));
        });
        await jobs.runKey(key);
        expect(await delivery(d.id)).toMatchObject({
          status: 'FAILED',
          last_error: 'EMAIL_PROVIDER_UNAVAILABLE',
        });
        // The failing attempt's own call had no definitive answer.
        expect((await latest(s.id, d.id)).possibly_delivered).toBe(true);
      });

      it('an archive waits for an in-flight send; later sends are refused', async () => {
        const s = await newSubscriber();
        const d = await deliveries.create(s.id, 1, admin);
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started = () => {};
        const inFlight = new Promise<void>((resolve) => {
          started = resolve;
        });
        fetchMock.mockImplementation(async (_url, init) => {
          record(init);
          started();
          await gate;
          return accept('msg-gated');
        });
        const running = jobs.runKey(baseDeliveryWorkKey(d.id, 1));
        await inFlight;
        // While waiting for the provider: no row lock on the subscriber and
        // only the work-guard connection is inside a transaction.
        const { rows: held } = await pool.query<{
          row_locks: number;
          in_tx: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM pg_locks
              WHERE relation = 'base_subscribers'::regclass) AS row_locks,
             (SELECT count(*)::int FROM pg_stat_activity
              WHERE datname = current_database()
                AND state LIKE 'idle in transaction%') AS in_tx`,
        );
        expect(held[0]).toEqual({ row_locks: 0, in_tx: 1 });
        let archived = false;
        const archiving = subscribers
          .setArchived(s.id, true, admin)
          .then(() => {
            archived = true;
          });
        await sleep(500);
        expect(archived).toBe(false);
        release();
        await running;
        await archiving;
        expect(archived).toBe(true);
        expect(await delivery(d.id)).toMatchObject({
          status: 'SENT',
          provider_message_id: 'msg-gated',
        });
        expect(
          await httpError(deliveries.create(s.id, 2, admin)),
        ).toMatchObject({
          code: 'SUBSCRIBER_ARCHIVED',
        });
      });

      describe('S1: a failure after a possible acceptance is ambiguous', () => {
        it('archived after an attempt without answer: possibly delivered', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          const key = baseDeliveryWorkKey(d.id, 1);
          timeoutOnce();
          await jobs.runKey(key);
          expect(await work(key)).toMatchObject({
            status: 'PENDING',
            last_error: 'EMAIL_PROVIDER_UNREACHABLE',
          });
          await subscribers.setArchived(s.id, true, admin);
          await due(key);
          await jobs.runKey(key);
          expect(sent).toHaveLength(1);
          expect(await delivery(d.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'SUBSCRIBER_ARCHIVED',
          });
          expect(await latest(s.id, d.id)).toMatchObject({
            possibly_delivered: true,
            sends: [
              {
                status: 'FAILED',
                error: 'SUBSCRIBER_ARCHIVED',
                possibly_delivered: true,
              },
            ],
          });
        });

        it('source missing after an attempt without answer: possibly delivered', async () => {
          const s = await newSubscriber({ days: 4 });
          const d = await deliveries.create(s.id, 1, admin);
          const key = baseDeliveryWorkKey(d.id, 1);
          timeoutOnce();
          await jobs.runKey(key);
          const path = join(catalogue, training(4, 1));
          try {
            rmSync(path);
            await due(key);
            await jobs.runKey(key);
          } finally {
            writeFileSync(path, originals.get(training(4, 1))!);
          }
          expect(sent).toHaveLength(1);
          expect(await delivery(d.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'BASE_CONTENT_UNAVAILABLE',
          });
          expect(await latest(s.id, d.id)).toMatchObject({
            possibly_delivered: true,
            sends: [
              { error: 'BASE_CONTENT_UNAVAILABLE', possibly_delivered: true },
            ],
          });
        });

        it('a definitive rejection after an attempt without answer stays possibly delivered', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          const key = baseDeliveryWorkKey(d.id, 1);
          fetchMock.mockImplementation((_url, init) => {
            record(init);
            return sent.length === 1
              ? Promise.reject(new Error('timeout'))
              : Promise.resolve(
                  new Response(JSON.stringify({ name: 'validation_error' }), {
                    status: 422,
                  }),
                );
          });
          await jobs.runKey(key);
          await due(key);
          await jobs.runKey(key);
          expect(await delivery(d.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'EMAIL_REQUEST_REJECTED',
          });
          expect((await latest(s.id, d.id)).possibly_delivered).toBe(true);
        });
      });

      describe('S2: each send has its own recipient snapshot', () => {
        it('a resend goes to the CURRENT name and email and stamps them; history keeps each send', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          fetchMock.mockImplementation((_url, init) => {
            record(init);
            return Promise.resolve(
              new Response(JSON.stringify({ name: 'validation_error' }), {
                status: 422,
              }),
            );
          });
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          expect((await delivery(d.id)).status).toBe('FAILED');
          const fixed = uniqueEmail();
          await subscribers.update(
            s.id,
            { name: 'Ana María', email: fixed },
            admin,
          );
          fetchMock.mockImplementation((_url, init) => {
            record(init);
            return Promise.resolve(accept('msg-fixed'));
          });
          const resent = await deliveries.resend(s.id, d.id, superAdmin);
          expect(resent).toMatchObject({
            month: 1,
            status: 'PENDING',
            send_seq: 2,
            snapshot_name: 'Ana María',
            snapshot_email: fixed,
            snapshot_goal: GOAL,
            snapshot_days_per_week: 3,
            snapshot_order_code: s.order_code,
          });
          // Delivery-level files (sources, original send) never change.
          expect(resent.files).toEqual(d.files);
          expect(
            resent.sends.map((entry) => [
              entry.send_seq,
              entry.snapshot_name,
              entry.snapshot_email,
            ]),
          ).toEqual([
            [1, 'Ana Pérez', s.email],
            [2, 'Ana María', fixed],
          ]);
          const key2 = baseDeliveryWorkKey(d.id, 2);
          await jobs.runKey(key2);
          expect(sent).toHaveLength(2);
          expect(sent[1].json.to).toBe(fixed);
          expect(sent[0].json.to).toBe(s.email);
          const stamped = await PDFDocument.load(
            Buffer.from(sent[1].json.attachments[0].content, 'base64'),
            { updateMetadata: false },
          );
          expect(stamped.getSubject()).toBe(
            `Licencia personal de Ana María (${fixed}) · Pedido ${s.order_code}`,
          );
          expect(sent[1].json.attachments.map((file) => file.filename)).toEqual(
            sent[0].json.attachments.map((file) => file.filename),
          );
          const second = parseBaseDeliveryPayload((await work(key2)).payload)!;
          sent[1].json.attachments.forEach((attachment, index) =>
            expect(sha(Buffer.from(attachment.content, 'base64'))).toBe(
              second.files[index].sha256,
            ),
          );
          expect(await delivery(d.id)).toMatchObject({
            status: 'SENT',
            provider_message_id: 'msg-fixed',
            snapshot_email: fixed,
          });
          // Month 2 is no longer blocked and uses the corrected data.
          expect(await deliveries.create(s.id, 2, admin)).toMatchObject({
            month: 2,
            snapshot_email: fixed,
          });
        });

        it('a resend without edits is unchanged', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          const resent = await deliveries.resend(s.id, d.id, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
          expect(resent).toMatchObject({
            snapshot_name: 'Ana Pérez',
            snapshot_email: s.email,
          });
          expect(sent.map((request) => request.json.to)).toEqual([
            s.email,
            s.email,
          ]);
          expect(sent[1].json.attachments).toEqual(sent[0].json.attachments);
          const [first, second] = await Promise.all(
            [1, 2].map(async (seq) =>
              parseBaseDeliveryPayload(
                (await work(baseDeliveryWorkKey(d.id, seq))).payload,
              ),
            ),
          );
          expect(second?.files).toEqual(first?.files);
        });

        it('a retry of the same send never switches address after an edit', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          const key = baseDeliveryWorkKey(d.id, 1);
          timeoutOnce();
          await jobs.runKey(key);
          await subscribers.update(s.id, { email: uniqueEmail() }, admin);
          expect(
            await httpError(deliveries.resend(s.id, d.id, admin)),
          ).toMatchObject({ status: 409, code: 'DELIVERY_PENDING' });
          await due(key);
          await jobs.runKey(key);
          expect(sent).toHaveLength(2);
          expect(sent[1].key).toBe(sent[0].key);
          expect(sent[1].body).toBe(sent[0].body);
          expect(sent[1].json.to).toBe(s.email);
          expect(await delivery(d.id)).toMatchObject({
            status: 'SENT',
            send_seq: 1,
            snapshot_email: s.email,
          });
        });

        it('an email edit committed while a resend waits for the lock yields one consistent snapshot', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          const before = await delivery(d.id);
          const edited = uniqueEmail();
          const holder = await pool.connect();
          let result: PromiseSettledResult<unknown>[] = [];
          try {
            // The edit holds the row; the resend stamps the old address, then
            // queues on the lock and must notice the change.
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM base_subscribers WHERE id = $1 FOR UPDATE',
              [s.id],
            );
            await holder.query(
              'UPDATE base_subscribers SET email = $2 WHERE id = $1',
              [s.id, edited],
            );
            const racing = Promise.allSettled([
              deliveries.resend(s.id, d.id, admin),
            ]);
            const holderPid = (
              await holder.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0].pid;
            for (let attempt = 0; ; attempt++) {
              const { rows } = await pool.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> $2`,
                ['%FROM base_subscribers WHERE id = $1 FOR UPDATE%', holderPid],
              );
              if (rows[0].n === 1) break;
              if (attempt > 300) throw Error('Resend never reached the lock');
              await sleep(50);
            }
            await holder.query('COMMIT');
            result = await racing;
          } finally {
            holder.release();
          }
          const [outcome] = result;
          if (outcome.status !== 'rejected') throw Error('Expected rejection');
          expect(httpErrorOf(outcome.reason)).toMatchObject({
            status: 409,
            code: 'SUBSCRIBER_CHANGED',
          });
          expect(await delivery(d.id)).toEqual(before);
          expect(
            await db.durableWork.count({
              where: { key: { startsWith: `base-delivery:${d.id}:` } },
            }),
          ).toBe(1);
          // Retried after the edit: row, payload and request all agree.
          const resent = await deliveries.resend(s.id, d.id, admin);
          expect(resent.snapshot_email).toBe(edited);
          expect(resent.sends[1].snapshot_email).toBe(edited);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
          expect(sent[1].json.to).toBe(edited);
        });
      });

      describe('S3: stamped hashes belong to a send, sources to the delivery', () => {
        it('a resend after a stamping change records and sends the new stamped hashes', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          stamper.variant = 'pdf-lib-upgrade';
          await deliveries.resend(s.id, d.id, admin);
          const key2 = baseDeliveryWorkKey(d.id, 2);
          await jobs.runKey(key2);
          expect(await delivery(d.id)).toMatchObject({
            status: 'SENT',
            send_seq: 2,
          });
          const second = parseBaseDeliveryPayload((await work(key2)).payload)!;
          expect(second.files.map((file) => file.source_sha256)).toEqual(
            d.files.map((file) => file.source_sha256),
          );
          second.files.forEach((file, index) =>
            expect(file.sha256).not.toBe(d.files[index].sha256),
          );
          sent[1].json.attachments.forEach((attachment, index) =>
            expect(sha(Buffer.from(attachment.content, 'base64'))).toBe(
              second.files[index].sha256,
            ),
          );
          // The delivery row keeps the original send's record.
          expect(parseRecordedFiles((await delivery(d.id)).files)).toEqual(
            d.files,
          );
        });

        it('a stamping change in the middle of one send fails only that send, as nothing sent', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          stamper.variant = 'pdf-lib-upgrade';
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          expect(sent).toHaveLength(0);
          expect(await latest(s.id, d.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'BASE_SOURCE_CHANGED',
            possibly_delivered: false,
          });
          await deliveries.resend(s.id, d.id, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
          expect((await delivery(d.id)).status).toBe('SENT');
        });

        it('a resend is refused when a source PDF changed since the delivery', async () => {
          const s = await newSubscriber({ days: 4 });
          const d = await deliveries.create(s.id, 1, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          const before = await delivery(d.id);
          const path = join(catalogue, guide(1));
          try {
            writeFileSync(path, await samplePdf('corrected guide'));
            expect(
              await httpError(deliveries.resend(s.id, d.id, admin)),
            ).toMatchObject({
              status: 409,
              code: 'SOURCE_CHANGED_SINCE_DELIVERY',
            });
          } finally {
            writeFileSync(path, originals.get(guide(1))!);
          }
          expect(await delivery(d.id)).toEqual(before);
          expect(
            await db.durableWork.count({
              where: { key: { startsWith: `base-delivery:${d.id}:` } },
            }),
          ).toBe(1);
          expect(sent).toHaveLength(1);
        });
      });

      describe('R4: resend races and sends whose failure was not recorded', () => {
        it('a resend that waited on a row lock while another resend was sent creates nothing (DELIVERY_CHANGED)', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 1));
          expect(await delivery(d.id)).toMatchObject({
            status: 'SENT',
            send_seq: 1,
          });
          const holder = await pool.connect();
          let result: PromiseSettledResult<unknown>[] = [];
          let before: Awaited<ReturnType<typeof delivery>> | null = null;
          try {
            // Request B validates and stamps against SENT/send 1, then waits
            // on the row lock of its actor (first lock of its transaction).
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM users WHERE id = $1 FOR UPDATE',
              [superAdmin.id],
            );
            const holderPid = (
              await holder.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0].pid;
            const racing = Promise.allSettled([
              deliveries.resend(s.id, d.id, superAdmin),
            ]);
            for (let attempt = 0; ; attempt++) {
              const { rows } = await pool.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE wait_event_type = 'Lock' AND query LIKE $1 AND pid <> $2`,
                ['%FROM users WHERE id = $1 FOR SHARE%', holderPid],
              );
              if (rows[0].n === 1) break;
              if (attempt > 300) throw Error('Resend B never reached the lock');
              await sleep(50);
            }
            // Request A (same starting state) commits send 2, and send 2 is
            // accepted, while B is still blocked.
            const first = await deliveries.resend(s.id, d.id, admin);
            expect(first).toMatchObject({ send_seq: 2, status: 'PENDING' });
            await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
            before = await delivery(d.id);
            expect(before).toMatchObject({ status: 'SENT', send_seq: 2 });
            await holder.query('COMMIT');
            result = await racing;
          } finally {
            holder.release();
          }
          const [outcome] = result;
          if (outcome.status !== 'rejected')
            throw Error('Expected the second resend to be rejected');
          expect(httpErrorOf(outcome.reason)).toMatchObject({
            status: 409,
            code: 'DELIVERY_CHANGED',
          });
          // Nothing written: no send 3, no extra email.
          expect(await delivery(d.id)).toEqual(before);
          expect(
            await db.durableWork.count({
              where: { key: { startsWith: `base-delivery:${d.id}:` } },
            }),
          ).toBe(2);
          expect(sent).toHaveLength(2);
        });

        it('a send FAILED without its terminal hook reads FAILED, blocks month N+1 and can be resent once', async () => {
          const s = await newSubscriber();
          const d = await deliveries.create(s.id, 1, admin);
          const key = baseDeliveryWorkKey(d.id, 1);
          // The state a hook failing 3 times leaves: work FAILED after one
          // provider hand-off, no possiblyDelivered, delivery still PENDING.
          const queued = parseBaseDeliveryPayload((await work(key)).payload)!;
          await db.durableWork.update({
            where: { key },
            data: {
              status: 'FAILED',
              attempts: WORK_MAX_ATTEMPTS,
              last_error: 'EMAIL_PROVIDER_UNAVAILABLE',
              payload: basePayloadJson({
                ...queued,
                preparedAt: new Date().toISOString(),
                handoffs: 1,
                lastHandoffAttempt: WORK_MAX_ATTEMPTS,
              }),
            },
          });
          expect(await delivery(d.id)).toMatchObject({
            status: 'PENDING',
            send_seq: 1,
          });

          expect(await latest(s.id, d.id)).toMatchObject({
            status: 'FAILED',
            last_error: 'SEND_STATE_UNRECORDED',
            possibly_delivered: true,
            sends: [
              {
                send_seq: 1,
                status: 'FAILED',
                error: 'EMAIL_PROVIDER_UNAVAILABLE',
                possibly_delivered: true,
              },
            ],
          });
          expect((await subscribers.get(s.id)).latest_delivery).toEqual({
            id: d.id,
            month: 1,
            status: 'FAILED',
            send_seq: 1,
          });
          expect(
            await httpError(deliveries.create(s.id, 2, admin)),
          ).toMatchObject({
            status: 409,
            code: 'PREVIOUS_MONTH_NOT_SENT',
            message:
              'No se puede enviar el mes 2: el envío del mes 1 ha fallado. Reenvía el mes 1 primero y, cuando conste como enviado, envía el mes 2.',
          });

          const resent = await deliveries.resend(s.id, d.id, admin);
          expect(resent).toMatchObject({
            status: 'PENDING',
            send_seq: 2,
            last_error: null,
            possibly_delivered: false,
          });
          expect(resent.sends.map((entry) => entry.status)).toEqual([
            'FAILED',
            'PENDING',
          ]);
          expect(
            await db.durableWork.findMany({
              where: { key: { startsWith: `base-delivery:${d.id}:` } },
              select: { key: true, status: true },
              orderBy: { key: 'asc' },
            }),
          ).toEqual([
            { key, status: 'FAILED' },
            { key: baseDeliveryWorkKey(d.id, 2), status: 'PENDING' },
          ]);
          await jobs.runKey(baseDeliveryWorkKey(d.id, 2));
          expect(sent).toHaveLength(1);
          expect(await delivery(d.id)).toMatchObject({
            status: 'SENT',
            send_seq: 2,
          });
          expect(await deliveries.create(s.id, 2, admin)).toMatchObject({
            month: 2,
          });
        });
      });
    });
  },
);
