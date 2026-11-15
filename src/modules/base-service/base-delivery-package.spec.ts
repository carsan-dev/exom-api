import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { BaseServiceScope } from '@prisma/client';
import { BaseServiceError } from './base-service.error';
import { BasePdfSource } from './base-pdf-source';
import { buildDeliveryPackage } from './base-delivery-package';

class MemorySource implements BasePdfSource {
  readonly reads: string[] = [];

  constructor(private readonly files: Map<string, Buffer>) {}

  list(): Promise<string[]> {
    return Promise.resolve([...this.files.keys()]);
  }

  get(key: string): Promise<Buffer> {
    this.reads.push(key);
    const bytes = this.files.get(key);
    if (!bytes) return Promise.reject(new Error(`missing ${key}`));
    return Promise.resolve(bytes);
  }
}

async function onePagePdf(title: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(title);
  doc.addPage([400, 600]).drawText(title, { x: 20, y: 300, size: 12 });
  return Buffer.from(await doc.save());
}

const TRAINING = 'entrenamiento/x/EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf';
const GUIDE = 'nutricion/x/EXOM_Nutricion_X_Guia-01.pdf';
const START = 'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf';
const TRAINING_2 = 'entrenamiento/x/EXOM_Entrenamiento_X_3-dias_Bloque-02.pdf';
const GUIDE_2 = 'nutricion/x/EXOM_Nutricion_X_Guia-02.pdf';

describe('buildDeliveryPackage', () => {
  let files: Map<string, Buffer>;

  beforeAll(async () => {
    files = new Map<string, Buffer>();
    for (const key of [TRAINING, GUIDE, START, TRAINING_2, GUIDE_2]) {
      files.set(key, await onePagePdf(key));
    }
  });

  it('stamps every selected file, keeping basenames and hashing the output', async () => {
    const source = new MemorySource(files);
    const result = await buildDeliveryPackage(source, {
      name: '  Ana   Pérez ',
      email: '  Ana.Perez@Example.TEST ',
      orderCode: 'ex-7',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.BOTH,
    });

    expect(result.files.map((file) => file.sourceKey)).toEqual([
      TRAINING,
      GUIDE,
      START,
    ]);
    expect(result.files.map((file) => file.filename)).toEqual([
      'EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf',
      'EXOM_Nutricion_X_Guia-01.pdf',
      'EXOM_Nutricion_Guia-de-inicio.pdf',
    ]);
    for (const file of result.files) {
      expect(file.sha256).toBe(
        createHash('sha256').update(file.bytes).digest('hex'),
      );
      const doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
      expect(doc.getSubject()).toBe(
        'Licencia personal de Ana Pérez (ana.perez@example.test) · Pedido EX-7',
      );
      expect(doc.getKeywords()).toBe('EXOM;EX-7');
      expect(doc.getTitle()).toBe(file.sourceKey);
    }
    expect(source.reads).toEqual([TRAINING, GUIDE, START]);
  });

  it('month 2 delivers two files', async () => {
    const result = await buildDeliveryPackage(new MemorySource(files), {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 2,
      scope: BaseServiceScope.BOTH,
    });
    expect(result.files.map((file) => file.sourceKey)).toEqual([
      TRAINING_2,
      GUIDE_2,
    ]);
  });

  it('validates name, email and order code before reading any file', async () => {
    const source = new MemorySource(files);
    const badName = await buildDeliveryPackage(source, {
      name: 'Ana\nPérez',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.BOTH,
    }).catch((error: unknown) => error);
    const badCode = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'COM1',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.BOTH,
    }).catch((error: unknown) => error);
    const badMonth = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 4,
      scope: BaseServiceScope.BOTH,
    }).catch((error: unknown) => error);
    const badEmail = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@exa mple.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.BOTH,
    }).catch((error: unknown) => error);

    expect(badEmail).toMatchObject({ code: 'INVALID_EMAIL' });
    expect(badName).toBeInstanceOf(BaseServiceError);
    expect(badName).toMatchObject({ code: 'INVALID_NAME' });
    expect(badCode).toBeInstanceOf(BaseServiceError);
    expect(badCode).toMatchObject({ code: 'INVALID_ORDER_CODE' });
    expect(badMonth).toBeInstanceOf(BaseServiceError);
    expect(badMonth).toMatchObject({ code: 'NO_CONTENT_FOR_MONTH' });
    expect(source.reads).toEqual([]);
  });

  it('TRAINING stamps and reads only the training block', async () => {
    const source = new MemorySource(files);
    const result = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.TRAINING,
    });
    expect(result.files.map((file) => file.sourceKey)).toEqual([TRAINING]);
    expect(source.reads).toEqual([TRAINING]);
  });

  it('NUTRITION stamps and reads only the nutrition guides', async () => {
    const source = new MemorySource(files);
    const month1 = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 1,
      scope: BaseServiceScope.NUTRITION,
    });
    const month2 = await buildDeliveryPackage(source, {
      name: 'Ana',
      email: 'ana@example.test',
      orderCode: 'EX-1',
      objetivo: 'x',
      dias: 3,
      mes: 2,
      scope: BaseServiceScope.NUTRITION,
    });
    expect(month1.files.map((file) => file.sourceKey)).toEqual([GUIDE, START]);
    expect(month2.files.map((file) => file.sourceKey)).toEqual([GUIDE_2]);
    expect(source.reads).toEqual([GUIDE, START, GUIDE_2]);
  });
});
