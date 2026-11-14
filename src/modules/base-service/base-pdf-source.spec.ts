import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseServiceError } from './base-service.error';
import { LocalDirBasePdfSource } from './base-pdf-source';

describe('LocalDirBasePdfSource', () => {
  let parent: string;
  let root: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'exom-base-source-'));
    root = join(parent, 'root');
    await mkdir(join(root, 'entrenamiento', 'x'), { recursive: true });
    await mkdir(join(root, 'nutricion'), { recursive: true });
    await writeFile(
      join(
        root,
        'entrenamiento',
        'x',
        'EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf',
      ),
      'training',
    );
    await writeFile(
      join(root, 'nutricion', 'EXOM_Nutricion_Guia-de-inicio.pdf'),
      'start',
    );
    await writeFile(join(parent, 'secret.pdf'), 'outside');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('lists every file as a sorted relative POSIX key', async () => {
    const source = new LocalDirBasePdfSource(root);
    await expect(source.list()).resolves.toEqual([
      'entrenamiento/x/EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf',
      'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf',
    ]);
  });

  it('reads a listed key', async () => {
    const source = new LocalDirBasePdfSource(root);
    const bytes = await source.get(
      'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf',
    );
    expect(bytes.toString('utf8')).toBe('start');
  });

  it.each([
    '../secret.pdf',
    'nutricion/../../secret.pdf',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'nutricion\\..\\..\\secret.pdf',
    '',
    'nutricion//EXOM_Nutricion_Guia-de-inicio.pdf',
    './nutricion/EXOM_Nutricion_Guia-de-inicio.pdf',
    'nutricion/\0.pdf',
  ])('rejects the key %j that escapes or is not canonical', async (key) => {
    const source = new LocalDirBasePdfSource(root);
    const error: unknown = await source.get(key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaseServiceError);
    expect(error).toMatchObject({ code: 'INVALID_SOURCE_KEY' });
  });

  it('reports a missing key as SOURCE_NOT_FOUND', async () => {
    const source = new LocalDirBasePdfSource(root);
    const error: unknown = await source
      .get('nutricion/nope.pdf')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaseServiceError);
    expect(error).toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });
});
