import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PDFDocument } from '@cantoo/pdf-lib';
import { BaseDelivery, BaseDeliveryStatus, Role } from '@prisma/client';
import { assertRouteExists, isBaseServiceRole } from './base-service.access';
import {
  baseDeliveryView,
  baseSendView,
  mapDeliveryPackageError,
  nextMonthRuleError,
} from './base-deliveries.service';
import {
  failedSendPossiblyDelivered,
  parseDeliveryStatus,
  SEND_STATE_UNRECORDED,
  sendFailureUnrecorded,
} from './base-delivery-state';
import {
  BASE_SERVICE_ROLES,
  baseDeliveryWorkKey,
} from './base-service.constants';
import { BaseServiceError } from './base-service.error';
import { mapSourceError } from './base-service.http-errors';
import { BasePdfSource } from './base-pdf-source';
import { BaseSourceNotConfiguredError } from './base-pdf-source.provider';
import {
  assertMatchesRecorded,
  compareResendMaterial,
  DeliveryFilesMismatchError,
  parseRecordedFiles,
  prepareDeliveryFiles,
  sameSources,
} from './base-delivery-files';
import {
  basePayloadJson,
  parseBaseDeliveryPayload,
  sendPossiblyDelivered,
} from './base-delivery.payload';
import { stampPdf } from './base-pdf-stamp';

const TRAINING_1 =
  'entrenamiento/perder-grasa/EXOM_Entrenamiento_Perder-grasa_3-dias_Bloque-01.pdf';
const GUIDE_1 =
  'nutricion/perder-grasa/EXOM_Nutricion_Perder-grasa_Guia-01.pdf';
const START = 'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf';

async function pdf(title: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.addPage([400, 600]).drawText(title.slice(-20), { x: 20, y: 300 });
  return Buffer.from(await doc.save());
}

class MemorySource implements BasePdfSource {
  constructor(readonly files: Map<string, Buffer>) {}
  list() {
    return Promise.resolve([...this.files.keys()]);
  }
  get(key: string) {
    const bytes = this.files.get(key);
    return bytes
      ? Promise.resolve(bytes)
      : Promise.reject(new BaseServiceError('SOURCE_NOT_FOUND', key));
  }
}

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function httpOf(error: HttpException) {
  const body = error.getResponse();
  return {
    status: error.getStatus(),
    code:
      typeof body === 'object' && body !== null && 'code' in body
        ? body.code
        : undefined,
  };
}

describe('base-service roles', () => {
  it('allows ADMIN and SUPER_ADMIN only, from one constant', () => {
    expect(BASE_SERVICE_ROLES).toEqual([Role.ADMIN, Role.SUPER_ADMIN]);
    expect(isBaseServiceRole(Role.ADMIN)).toBe(true);
    expect(isBaseServiceRole(Role.SUPER_ADMIN)).toBe(true);
    expect(isBaseServiceRole(Role.CLIENT)).toBe(false);
  });

  it('keys each send separately (idempotency key per send_seq)', () => {
    expect(baseDeliveryWorkKey('d', 1)).toBe('base-delivery:d:1');
    expect(baseDeliveryWorkKey('d', 2)).not.toBe(baseDeliveryWorkKey('d', 1));
  });
});

describe('assertRouteExists', () => {
  const keys = [TRAINING_1, GUIDE_1, START];
  it('accepts an offered route', () => {
    expect(() => assertRouteExists(keys, 'perder-grasa', 3)).not.toThrow();
  });
  it.each([
    [[], 'perder-grasa', 3, 'EMPTY_CATALOG'],
    [keys, 'ganar-musculo', 3, 'INVALID_GOAL'],
    [keys, 'perder-grasa', 5, 'INVALID_DAYS'],
  ])('rejects %#', (catalogue, goal, days, code) => {
    let thrown: unknown;
    try {
      assertRouteExists(catalogue, goal, days);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaseServiceError);
    expect(thrown).toMatchObject({ code });
  });
});

describe('mapSourceError', () => {
  it.each([
    ['INVALID_NAME', 'subscriber', 400],
    ['INVALID_GOAL', 'subscriber', 400],
    ['INVALID_DAYS', 'subscriber', 400],
    ['INVALID_GOAL', 'delivery', 409],
    ['INVALID_DAYS', 'delivery', 409],
    ['NO_CONTENT_FOR_MONTH', 'delivery', 409],
    ['INVALID_MONTH', 'delivery', 400],
    ['EMPTY_CATALOG', 'delivery', 503],
    ['AMBIGUOUS_CONTENT', 'delivery', 503],
    ['MISSING_START_GUIDE', 'delivery', 503],
    ['SOURCE_NOT_FOUND', 'delivery', 503],
    ['STAMP_TOO_LONG', 'subscriber', 400],
    ['STAMP_TOO_LONG', 'delivery', 409],
  ] as const)('%s in %s -> %i', (code, context, status) => {
    const mapped = mapSourceError(new BaseServiceError(code, 'msg'), context);
    expect(httpOf(mapped)).toEqual({ status, code });
  });

  it('keeps the NO_CONTENT_FOR_MONTH message listing the available months', () => {
    const error = new BaseServiceError(
      'NO_CONTENT_FOR_MONTH',
      'Todavía no hay contenido de entrenamiento para el mes 4 (x, 3 días). Meses disponibles: 1, 2, 3.',
    );
    const body = mapSourceError(error, 'delivery').getResponse();
    expect(body).toMatchObject({ message: error.message });
  });

  it('maps an unconfigured source to 503 SOURCE_NOT_CONFIGURED', () => {
    expect(
      httpOf(
        mapSourceError(
          new BaseSourceNotConfiguredError('NOT_CONFIGURED'),
          'subscriber',
        ),
      ),
    ).toEqual({ status: 503, code: 'SOURCE_NOT_CONFIGURED' });
  });

  it('hides storage errors behind 503 SOURCE_UNAVAILABLE', () => {
    const mapped = mapSourceError(
      new Error('https://bucket.example.test/key?X-Amz-Signature=secret'),
      'delivery',
    );
    expect(httpOf(mapped)).toEqual({
      status: 503,
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(JSON.stringify(mapped.getResponse())).not.toContain('Signature');
  });
});

describe('prepareDeliveryFiles / assertMatchesRecorded', () => {
  let files: Map<string, Buffer>;
  const input = {
    name: 'Ana Pérez',
    email: 'ana@example.test',
    orderCode: 'EXB-000001',
    objetivo: 'perder-grasa',
    dias: 3,
    mes: 1,
  };

  beforeAll(async () => {
    files = new Map();
    for (const key of [TRAINING_1, GUIDE_1, START])
      files.set(key, await pdf(key));
  });

  it('records source hashes, stamped hashes and sizes per file', async () => {
    const prepared = await prepareDeliveryFiles(new MemorySource(files), input);
    expect(prepared.recorded.map((file) => file.source_key)).toEqual([
      TRAINING_1,
      GUIDE_1,
      START,
    ]);
    prepared.recorded.forEach((file, index) => {
      const built = prepared.package.files[index];
      expect(file.filename).toBe(built.filename);
      expect(file.source_sha256).toBe(sha(files.get(file.source_key)!));
      expect(file.sha256).toBe(sha(built.bytes));
      expect(file.size).toBe(built.bytes.byteLength);
      expect(file.sha256).not.toBe(file.source_sha256);
    });
  });

  it('rebuilds identical stamped bytes for the same snapshot', async () => {
    const first = await prepareDeliveryFiles(new MemorySource(files), input);
    const second = await prepareDeliveryFiles(new MemorySource(files), input);
    expect(() => assertMatchesRecorded(first.recorded, second)).not.toThrow();
  });

  it('detects a changed source file', async () => {
    const recorded = (
      await prepareDeliveryFiles(new MemorySource(files), input)
    ).recorded;
    const changed = new Map(files);
    changed.set(GUIDE_1, await pdf('otra guía'));
    const rebuilt = await prepareDeliveryFiles(
      new MemorySource(changed),
      input,
    );
    expect(() => assertMatchesRecorded(recorded, rebuilt)).toThrow(
      DeliveryFilesMismatchError,
    );
  });

  it('records different stamped hashes but the same sources when the stamper changes', async () => {
    const original = await prepareDeliveryFiles(new MemorySource(files), input);
    // Simulates a PDF-library or font upgrade: same sources, other bytes.
    const upgraded = await prepareDeliveryFiles(
      new MemorySource(files),
      input,
      (source, options) =>
        stampPdf(source, { ...options, keywords: `${options.keywords};v2` }),
    );
    expect(upgraded.recorded.map((file) => file.sha256)).not.toEqual(
      original.recorded.map((file) => file.sha256),
    );
    expect(sameSources(original.recorded, upgraded.recorded)).toBe(true);
    // Within one send the stamped bytes are binding.
    expect(() => assertMatchesRecorded(original.recorded, upgraded)).toThrow(
      DeliveryFilesMismatchError,
    );
  });

  it('sameSources ignores stamped hashes and detects changed or reordered sources', async () => {
    const recorded = (
      await prepareDeliveryFiles(new MemorySource(files), input)
    ).recorded;
    const otherRecipient = (
      await prepareDeliveryFiles(new MemorySource(files), {
        ...input,
        email: 'otra@example.test',
      })
    ).recorded;
    expect(sameSources(recorded, otherRecipient)).toBe(true);
    const changed = new Map(files);
    changed.set(GUIDE_1, await pdf('otra guía'));
    const rebuilt = (
      await prepareDeliveryFiles(new MemorySource(changed), input)
    ).recorded;
    expect(sameSources(recorded, rebuilt)).toBe(false);
    expect(sameSources(recorded, [...recorded].reverse())).toBe(false);
    expect(sameSources(recorded, recorded.slice(1))).toBe(false);
  });

  it('compareResendMaterial: the reference decides confirmation, the original the history flag', async () => {
    const original = (
      await prepareDeliveryFiles(new MemorySource(files), input)
    ).recorded;
    const corrected = new Map(files);
    corrected.set(GUIDE_1, await pdf('guía corregida'));
    const current = (
      await prepareDeliveryFiles(new MemorySource(corrected), input)
    ).recorded;
    // First resend after the correction: needs confirmation.
    expect(compareResendMaterial(original, original, current)).toEqual({
      changedSinceReference: true,
      materialChanged: true,
    });
    // The confirmed send is now the reference: nothing to confirm.
    expect(compareResendMaterial(original, current, current)).toEqual({
      changedSinceReference: false,
      materialChanged: true,
    });
    // Back to the original bytes after a confirmed change.
    expect(compareResendMaterial(original, current, original)).toEqual({
      changedSinceReference: true,
      materialChanged: false,
    });
    expect(compareResendMaterial(original, original, original)).toEqual({
      changedSinceReference: false,
      materialChanged: false,
    });
    // A renamed file with identical bytes, an added and a removed file.
    const renamed = original.map((file) =>
      file.source_key === GUIDE_1
        ? {
            ...file,
            source_key: GUIDE_1.replace('_Guia', '-v2_Guia'),
            filename: file.filename.replace('_Guia', '-v2_Guia'),
          }
        : file,
    );
    for (const candidate of [
      renamed,
      [...original, { ...original[0], source_key: 'extra.pdf' }],
      original.slice(0, -1),
    ])
      expect(compareResendMaterial(original, original, candidate)).toEqual({
        changedSinceReference: true,
        materialChanged: true,
      });
  });

  it('refuses a name + email whose stamp cannot fit, before reading any PDF', async () => {
    const source = new MemorySource(files);
    const list = jest.spyOn(source, 'list');
    const get = jest.spyOn(source, 'get');
    let thrown: unknown;
    try {
      await prepareDeliveryFiles(source, {
        ...input,
        name: 'A'.repeat(80),
        email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.com`,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaseServiceError);
    expect(thrown).toMatchObject({ code: 'STAMP_TOO_LONG' });
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('parses only the recorded shape', () => {
    expect(parseRecordedFiles([])).toBeNull();
    expect(parseRecordedFiles([{ filename: 'a' }])).toBeNull();
    const entry = {
      filename: 'a.pdf',
      source_key: 'nutricion/a.pdf',
      source_sha256: 'x',
      sha256: 'y',
      size: 1,
    };
    expect(parseRecordedFiles([entry])).toEqual([entry]);
  });
});

describe('nextMonthRuleError (month N needs month N-1 SENT)', () => {
  const state = (
    max_month: number | null,
    previous_status: string | null,
    existing_status: string | null = null,
  ) => ({ max_month, previous_status, existing_status });
  const outcome = (error: HttpException | null) => {
    if (!error) return null;
    const body = error.getResponse();
    return {
      ...httpOf(error),
      message:
        typeof body === 'object' && body !== null && 'message' in body
          ? body.message
          : undefined,
    };
  };

  it('allows month 1 of a new subscriber', () => {
    expect(nextMonthRuleError(1, state(null, null))).toBeNull();
  });

  it('allows month N when month N-1 is SENT', () => {
    expect(nextMonthRuleError(2, state(1, 'SENT'))).toBeNull();
    expect(nextMonthRuleError(5, state(4, 'SENT'))).toBeNull();
  });

  it('refuses month N while month N-1 is PENDING', () => {
    expect(outcome(nextMonthRuleError(2, state(1, 'PENDING')))).toEqual({
      status: 409,
      code: 'PREVIOUS_MONTH_NOT_SENT',
      message:
        'No se puede enviar el mes 2: el mes 1 todavía está pendiente de envío. Espera a que termine su envío antes de enviar el mes 2.',
    });
  });

  it('refuses month N when month N-1 FAILED', () => {
    expect(outcome(nextMonthRuleError(3, state(2, 'FAILED')))).toEqual({
      status: 409,
      code: 'PREVIOUS_MONTH_NOT_SENT',
      message:
        'No se puede enviar el mes 3: el envío del mes 2 ha fallado. Reenvía el mes 2 primero y, cuando conste como enviado, envía el mes 3.',
    });
  });

  it('keeps the existing rules first: existing month, then next month', () => {
    expect(outcome(nextMonthRuleError(1, state(1, null, 'FAILED')))?.code).toBe(
      'DELIVERY_EXISTS',
    );
    expect(outcome(nextMonthRuleError(3, state(1, null)))).toMatchObject({
      status: 409,
      code: 'MONTH_NOT_NEXT',
      message: 'Solo se puede enviar el mes 2 a este suscriptor.',
    });
  });
});

describe('base delivery work payload', () => {
  const file = {
    filename: 'a.pdf',
    source_key: 'nutricion/a.pdf',
    source_sha256: 'x',
    sha256: 'y',
    size: 1,
  };
  const base = {
    deliveryId: 'd',
    sendSeq: 1,
    requestedById: 'admin',
    requestedAt: '2026-11-14T10:00:00.000Z',
    name: 'Ana',
    email: 'ana@example.test',
    files: [file],
  };

  it('round-trips identity, recipient, preparation, hand-offs and acceptance', () => {
    expect(parseBaseDeliveryPayload(basePayloadJson(base))).toEqual(base);
    const prepared = {
      ...base,
      preparedAt: '2026-11-14T10:00:05.000Z',
      request: { from: 'f', to: 't', subject: 's', html: 'h', text: 'x' },
      handoffs: 2,
      lastHandoffAttempt: 3,
    };
    expect(parseBaseDeliveryPayload(basePayloadJson(prepared))).toEqual(
      prepared,
    );
    const failed = { ...prepared, possiblyDelivered: true };
    expect(parseBaseDeliveryPayload(basePayloadJson(failed))).toEqual(failed);
    const accepted = {
      ...base,
      preparedAt: prepared.preparedAt,
      handoffs: 1,
      lastHandoffAttempt: 1,
      accepted: true as const,
      providerMessageId: 'msg',
      acceptedAt: '2026-11-14T10:00:06.000Z',
    };
    const json = basePayloadJson(accepted);
    expect(json).not.toHaveProperty('request');
    // The send keeps its recipient as history.
    expect(json).toMatchObject({ name: 'Ana', email: 'ana@example.test' });
    expect(parseBaseDeliveryPayload(json)).toEqual(accepted);
  });

  it('round-trips the confirmed-material markers through every rewrite', () => {
    const confirmed = {
      ...base,
      sendSeq: 2,
      materialChanged: true as const,
      acceptedChangedSource: true as const,
    };
    expect(parseBaseDeliveryPayload(basePayloadJson(confirmed))).toEqual(
      confirmed,
    );
    const accepted = {
      ...confirmed,
      preparedAt: '2026-11-14T10:00:05.000Z',
      handoffs: 1,
      lastHandoffAttempt: 1,
      accepted: true as const,
      providerMessageId: 'msg',
      acceptedAt: '2026-11-14T10:00:06.000Z',
    };
    expect(parseBaseDeliveryPayload(basePayloadJson(accepted))).toEqual(
      accepted,
    );
    // Unchanged material: no marker is written at all.
    const json = basePayloadJson({
      ...base,
      materialChanged: undefined,
      acceptedChangedSource: undefined,
    });
    expect(json).not.toHaveProperty('materialChanged');
    expect(json).not.toHaveProperty('acceptedChangedSource');
  });

  it.each([
    [null],
    [[]],
    [{ ...base, sendSeq: 0 }],
    [{ ...base, deliveryId: '' }],
    [{ ...base, accepted: true }],
    [{ ...base, request: { to: 'x' } }],
    [{ ...base, name: '' }],
    [{ ...base, email: undefined }],
    [{ ...base, files: [] }],
    [{ ...base, files: [{ filename: 'a.pdf' }] }],
    // A prepared send must count its provider calls.
    [{ ...base, preparedAt: '2026-11-14T10:00:05.000Z' }],
    [{ ...base, handoffs: 1 }],
    [{ ...base, handoffs: 0, lastHandoffAttempt: 1 }],
    [{ ...base, possiblyDelivered: 'yes' }],
    [{ ...base, materialChanged: false }],
    [{ ...base, materialChanged: 'true' }],
    [{ ...base, acceptedChangedSource: false }],
    [{ ...base, acceptedChangedSource: 1 }],
  ])('rejects malformed payload %#', (value) => {
    expect(parseBaseDeliveryPayload(value)).toBeNull();
  });
});

describe('sendPossiblyDelivered (terminal failure classification)', () => {
  const after = (handoffs?: number, lastHandoffAttempt?: number) => ({
    handoffs,
    lastHandoffAttempt,
  });

  it.each([
    // No provider call was ever started: provably nothing sent.
    ['SUBSCRIBER_ARCHIVED', after(), 1, false],
    ['BASE_CONTENT_UNAVAILABLE', after(), 3, false],
    ['BASE_SOURCE_UNAVAILABLE', after(), 8, false],
    ['ATTEMPTS_EXHAUSTED', after(), 9, false],
    // The only call was made by the failing attempt and definitively refused.
    ['EMAIL_REQUEST_REJECTED', after(1, 4), 4, false],
    ['EMAIL_PROVIDER_AUTH_REJECTED', after(1, 1), 1, false],
    ['EMAIL_PROVIDER_REJECTED', after(1, 1), 1, false],
    ['EMAIL_PROVIDER_NOT_CONFIGURED', after(1, 2), 2, false],
    // An earlier call got no definitive answer: may have been accepted.
    ['SUBSCRIBER_ARCHIVED', after(1, 1), 2, true],
    ['BASE_CONTENT_UNAVAILABLE', after(1, 1), 2, true],
    ['BASE_SOURCE_NOT_FOUND', after(1, 1), 2, true],
    ['BASE_SOURCE_CHANGED', after(1, 1), 2, true],
    ['BASE_SOURCE_NOT_CONFIGURED', after(1, 1), 2, true],
    ['EMAIL_PROVIDER_NOT_CONFIGURED', after(1, 1), 2, true],
    ['EMAIL_DEDUP_WINDOW_EXPIRED', after(1, 1), 2, true],
    ['ATTEMPTS_EXHAUSTED', after(1, 8), 9, true],
    ['ATTEMPT_FAILED_OR_AMBIGUOUS', after(1, 1), 1, true],
    [null, after(1, 1), 1, true],
    // The failing attempt's own call had no definitive answer.
    ['EMAIL_PROVIDER_UNAVAILABLE', after(1, 8), 8, true],
    ['EMAIL_PROVIDER_UNREACHABLE', after(1, 8), 8, true],
    ['EMAIL_IDEMPOTENCY_CONFLICT', after(1, 1), 1, true],
    // A definitive refusal never clears an earlier ambiguous call.
    ['EMAIL_REQUEST_REJECTED', after(2, 2), 2, true],
  ])('%s after %j at attempt %d -> %s', (code, payload, attempt, expected) => {
    expect(sendPossiblyDelivered(payload, attempt, code)).toBe(expected);
  });
});

describe('read-time state of a send and of its delivery', () => {
  const file = {
    filename: 'a.pdf',
    source_key: 'nutricion/a.pdf',
    source_sha256: 'x',
    sha256: 'y',
    size: 1,
  };
  const queued = {
    deliveryId: 'd1',
    sendSeq: 1,
    requestedById: 'admin',
    requestedAt: '2026-11-14T10:00:00.000Z',
    name: 'Ana',
    email: 'ana@example.test',
    files: [file],
  };
  const handedOff = (attempt: number) => ({
    ...queued,
    preparedAt: '2026-11-14T10:00:05.000Z',
    handoffs: 1,
    lastHandoffAttempt: attempt,
  });
  const failedRow = (
    payload: unknown,
    lastError: string | null,
    attempts = 8,
    sendSeq = 1,
  ) => ({
    key: baseDeliveryWorkKey('d1', sendSeq),
    status: 'FAILED',
    payload,
    attempts,
    last_error: lastError,
  });

  describe('possibly_delivered of a FAILED send', () => {
    it('respects a stored flag (true and false)', () => {
      // The stored value wins even where recomputing would say otherwise.
      expect(
        baseSendView(
          1,
          failedRow(
            basePayloadJson({ ...handedOff(8), possiblyDelivered: false }),
            'EMAIL_PROVIDER_UNAVAILABLE',
          ),
        ).possibly_delivered,
      ).toBe(false);
      expect(
        baseSendView(
          1,
          failedRow(
            basePayloadJson({ ...queued, possiblyDelivered: true }),
            'SUBSCRIBER_ARCHIVED',
          ),
        ).possibly_delivered,
      ).toBe(true);
    });

    it('flag absent + a hand-off without definitive answer -> true', () => {
      expect(
        baseSendView(
          1,
          failedRow(
            basePayloadJson(handedOff(8)),
            'EMAIL_PROVIDER_UNAVAILABLE',
          ),
        ),
      ).toMatchObject({ status: 'FAILED', possibly_delivered: true });
      // An earlier attempt's hand-off, any later failure.
      expect(
        baseSendView(
          1,
          failedRow(basePayloadJson(handedOff(2)), 'SUBSCRIBER_ARCHIVED', 3),
        ).possibly_delivered,
      ).toBe(true);
    });

    it('flag absent + no hand-off -> false (a single refused call stays false)', () => {
      expect(
        baseSendView(
          1,
          failedRow(basePayloadJson(queued), 'BASE_CONTENT_UNAVAILABLE'),
        ),
      ).toMatchObject({ status: 'FAILED', possibly_delivered: false });
      expect(
        baseSendView(
          1,
          failedRow(basePayloadJson(handedOff(4)), 'EMAIL_REQUEST_REJECTED', 4),
        ).possibly_delivered,
      ).toBe(false);
    });

    it('undeterminable (unreadable payload) -> true', () => {
      for (const payload of [null, { broken: true }, ['x']]) {
        expect(
          baseSendView(1, failedRow(payload, 'INVALID_BASE_DELIVERY_INTENT')),
        ).toMatchObject({ status: 'FAILED', possibly_delivered: true });
      }
      expect(failedSendPossiblyDelivered(null, 1, null)).toBe(true);
    });

    it('PENDING and SENT sends are never possibly delivered', () => {
      expect(
        baseSendView(1, {
          ...failedRow(
            basePayloadJson(handedOff(1)),
            'EMAIL_PROVIDER_UNREACHABLE',
          ),
          status: 'PENDING',
        }),
      ).toMatchObject({ status: 'PENDING', possibly_delivered: false });
      expect(
        baseSendView(1, {
          ...failedRow(
            basePayloadJson({
              ...handedOff(1),
              accepted: true,
              providerMessageId: 'msg',
              acceptedAt: '2026-11-14T10:00:06.000Z',
            }),
            null,
          ),
          status: 'DONE',
        }),
      ).toMatchObject({ status: 'SENT', possibly_delivered: false });
      expect(baseSendView(1, undefined)).toMatchObject({
        status: 'PENDING',
        possibly_delivered: false,
      });
    });
  });

  describe('effective delivery state (failure not recorded on the row)', () => {
    const row = (overrides: Partial<BaseDelivery> = {}): BaseDelivery => ({
      id: 'd1',
      subscriber_id: 's1',
      month: 1,
      status: BaseDeliveryStatus.PENDING,
      send_seq: 1,
      snapshot_name: 'Ana',
      snapshot_email: 'ana@example.test',
      snapshot_goal: 'perder-grasa',
      snapshot_days_per_week: 3,
      snapshot_order_code: 'EXB-000001',
      files: [file],
      requested_by_id: 'admin',
      requested_at: new Date('2026-11-14T10:00:00.000Z'),
      sent_at: null,
      provider_message_id: null,
      last_error: null,
      created_at: new Date('2026-11-14T10:00:00.000Z'),
      updated_at: new Date('2026-11-14T10:00:00.000Z'),
      ...overrides,
    });
    const byKey = (...rows: ReturnType<typeof failedRow>[]) =>
      new Map(rows.map((entry) => [entry.key, entry]));

    it('a PENDING delivery whose current send is terminally FAILED reads FAILED SEND_STATE_UNRECORDED', () => {
      expect(
        baseDeliveryView(
          row(),
          byKey(
            failedRow(
              basePayloadJson(handedOff(8)),
              'EMAIL_PROVIDER_UNAVAILABLE',
            ),
          ),
        ),
      ).toMatchObject({
        status: 'FAILED',
        last_error: SEND_STATE_UNRECORDED,
        possibly_delivered: true,
        sends: [
          {
            status: 'FAILED',
            error: 'EMAIL_PROVIDER_UNAVAILABLE',
            possibly_delivered: true,
          },
        ],
      });
      expect(
        baseDeliveryView(
          row(),
          byKey(failedRow(basePayloadJson(queued), 'BASE_SOURCE_CHANGED')),
        ),
      ).toMatchObject({
        status: 'FAILED',
        last_error: SEND_STATE_UNRECORDED,
        possibly_delivered: false,
      });
    });

    it('keeps the row state otherwise (send running, recorded, or an older send)', () => {
      const running = {
        ...failedRow(basePayloadJson(queued), 'EMAIL_PROVIDER_UNREACHABLE'),
        status: 'PENDING',
      };
      expect(baseDeliveryView(row(), byKey(running))).toMatchObject({
        status: 'PENDING',
        last_error: null,
      });
      expect(baseDeliveryView(row(), byKey())).toMatchObject({
        status: 'PENDING',
      });
      expect(
        baseDeliveryView(
          row({
            status: BaseDeliveryStatus.FAILED,
            last_error: 'EMAIL_REQUEST_REJECTED',
          }),
          byKey(failedRow(basePayloadJson(queued), 'EMAIL_REQUEST_REJECTED')),
        ),
      ).toMatchObject({
        status: 'FAILED',
        last_error: 'EMAIL_REQUEST_REJECTED',
      });
      // Send 1 failed; send 2 is the current one and has no terminal row.
      expect(
        baseDeliveryView(
          row({ send_seq: 2 }),
          byKey(failedRow(basePayloadJson(queued), 'EMAIL_REQUEST_REJECTED')),
        ),
      ).toMatchObject({ status: 'PENDING', last_error: null });
    });

    it('sendFailureUnrecorded needs a PENDING row and a FAILED, unaccepted work item', () => {
      const failed = { status: 'FAILED', payload: basePayloadJson(queued) };
      expect(sendFailureUnrecorded('PENDING', failed)).toBe(true);
      expect(
        sendFailureUnrecorded('PENDING', { ...failed, payload: null }),
      ).toBe(true);
      expect(sendFailureUnrecorded('SENT', failed)).toBe(false);
      expect(sendFailureUnrecorded('FAILED', failed)).toBe(false);
      expect(
        sendFailureUnrecorded('PENDING', { ...failed, status: 'RUNNING' }),
      ).toBe(false);
      expect(
        sendFailureUnrecorded('PENDING', {
          ...failed,
          payload: { ...basePayloadJson(queued), accepted: true },
        }),
      ).toBe(false);
      expect(sendFailureUnrecorded('PENDING', null)).toBe(false);
    });
  });

  describe('material of each send', () => {
    const corrected = { ...file, source_sha256: 'x2', sha256: 'y2' };
    const sentRow = (payload: unknown, sendSeq: number) => ({
      key: baseDeliveryWorkKey('d1', sendSeq),
      status: 'DONE',
      payload,
      attempts: 1,
      last_error: null,
    });

    it('material_changed compares the send with the delivery original; accepted_changed_source is the stored confirmation', () => {
      const original = [file];
      const plain = sentRow(basePayloadJson(queued), 1);
      const confirmedSend = sentRow(
        basePayloadJson({
          ...queued,
          sendSeq: 2,
          files: [corrected],
          materialChanged: true,
          acceptedChangedSource: true,
        }),
        2,
      );
      const repeated = sentRow(
        basePayloadJson({
          ...queued,
          sendSeq: 3,
          files: [corrected],
          materialChanged: true,
        }),
        3,
      );
      expect(
        [
          baseSendView(1, plain, original),
          baseSendView(2, confirmedSend, original),
          baseSendView(3, repeated, original),
        ].map((view) => [view.material_changed, view.accepted_changed_source]),
      ).toEqual([
        [false, false],
        [true, true],
        [true, false],
      ]);
      // Without the delivery's files, or with an unreadable send record.
      expect(baseSendView(2, confirmedSend).material_changed).toBe(false);
      expect(
        baseSendView(2, sentRow({ broken: true }, 2), original),
      ).toMatchObject({
        material_changed: false,
        accepted_changed_source: false,
      });
      expect(baseSendView(4, undefined, original)).toMatchObject({
        material_changed: false,
        accepted_changed_source: false,
      });
    });
  });

  it('parseDeliveryStatus accepts only the delivery-status enum', () => {
    expect(parseDeliveryStatus('SENT')).toBe(BaseDeliveryStatus.SENT);
    expect(parseDeliveryStatus('FAILED')).toBe(BaseDeliveryStatus.FAILED);
    expect(parseDeliveryStatus('PENDING')).toBe(BaseDeliveryStatus.PENDING);
    expect(parseDeliveryStatus('sent')).toBeNull();
    expect(parseDeliveryStatus('DONE')).toBeNull();
  });
});

describe('mapDeliveryPackageError (packages of create and resend)', () => {
  const messageOf = (error: HttpException) => {
    const body = error.getResponse();
    return typeof body === 'object' && body !== null && 'message' in body
      ? String(body.message)
      : '';
  };

  it('reports a stored invalid order code as an internal data problem, not as something to edit', () => {
    const mapped = mapDeliveryPackageError(
      new BaseServiceError('INVALID_ORDER_CODE', 'Pedido no válido'),
    );
    expect(httpOf(mapped)).toEqual({ status: 400, code: 'INVALID_ORDER_CODE' });
    expect(messageOf(mapped)).toContain('equipo técnico');
    expect(messageOf(mapped).toLowerCase()).not.toMatch(/edita|edítalo/);
  });

  it('leaves every other error to mapSourceError', () => {
    expect(
      httpOf(
        mapDeliveryPackageError(new BaseServiceError('STAMP_TOO_LONG', 'x')),
      ),
    ).toEqual({ status: 409, code: 'STAMP_TOO_LONG' });
    expect(
      httpOf(
        mapDeliveryPackageError(new BaseServiceError('INVALID_NAME', 'x')),
      ),
    ).toEqual({ status: 400, code: 'INVALID_NAME' });
  });
});
