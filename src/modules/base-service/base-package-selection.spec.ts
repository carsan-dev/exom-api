import { BaseServiceScope } from '@prisma/client';
import { BaseServiceError } from './base-service.error';
import {
  listRoutes,
  scopeMaterial,
  selectPackage,
  selectPackageFor,
} from './base-package-selection';

const START = 'nutricion/EXOM_Nutricion_Guia-de-inicio.pdf';

function training(
  objetivo: string,
  label: string,
  dias: string,
  bloque: string,
) {
  return `entrenamiento/${objetivo}/EXOM_Entrenamiento_${label}_${dias}-dias_Bloque-${bloque}.pdf`;
}

function guide(objetivo: string, label: string, guia: string) {
  return `nutricion/${objetivo}/EXOM_Nutricion_${label}_Guia-${guia}.pdf`;
}

/** Same shape as the real catalogue: 2 goals, 1-5 days, 3 months. */
function catalogue(): string[] {
  const keys: string[] = [START];
  for (const [objetivo, label] of [
    ['perder-grasa', 'Perder-grasa'],
    ['ganar-fuerza', 'Fuerza'],
  ]) {
    for (const bloque of ['01', '02', '03']) {
      for (const dias of ['1', '2', '3', '4', '5']) {
        keys.push(training(objetivo, label, dias, bloque));
      }
      keys.push(guide(objetivo, label, bloque));
    }
  }
  return keys;
}

function expectError(fn: () => unknown, code: string, ...fragments: string[]) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof BaseServiceError)) {
    throw new Error(`expected a BaseServiceError, got ${String(caught)}`);
  }
  const error = caught;
  expect(error.code).toBe(code);
  for (const fragment of fragments) {
    expect(error.message).toContain(fragment);
  }
}

describe('selectPackage', () => {
  it('month 1 returns block 1, guide 1 and the start guide, in that order', () => {
    expect(selectPackage(catalogue(), 'perder-grasa', 3, 1)).toEqual([
      training('perder-grasa', 'Perder-grasa', '3', '01'),
      guide('perder-grasa', 'Perder-grasa', '01'),
      START,
    ]);
  });

  it('month 2 returns two files without the start guide', () => {
    expect(selectPackage(catalogue(), 'ganar-fuerza', 5, 2)).toEqual([
      training('ganar-fuerza', 'Fuerza', '5', '02'),
      guide('ganar-fuerza', 'Fuerza', '02'),
    ]);
  });

  it('ignores keys outside the layout and keys in the wrong folder', () => {
    const keys = [
      ...catalogue(),
      'entrenamiento/perder-grasa/notes.txt',
      'entrenamiento/perder-grasa/sub/EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf',
      'nutricion/perder-grasa/EXOM_Entrenamiento_X_3-dias_Bloque-01.pdf',
      'otros/EXOM_Nutricion_X_Guia-01.pdf',
    ];
    expect(selectPackage(keys, 'perder-grasa', 3, 1)).toHaveLength(3);
  });

  it('rejects an unknown goal listing the goals discovered from the keys', () => {
    expectError(
      () => selectPackage(catalogue(), 'nope', 3, 1),
      'INVALID_GOAL',
      '«nope»',
      'Disponibles: ganar-fuerza, perder-grasa.',
    );
  });

  it('fails with EMPTY_CATALOG when there is no training content at all', () => {
    expectError(() => selectPackage([START], 'x', 1, 1), 'EMPTY_CATALOG');
  });

  it('rejects days not present for the goal listing the available days', () => {
    expectError(
      () => selectPackage(catalogue(), 'perder-grasa', 6, 1),
      'INVALID_DAYS',
      'Disponibles para perder-grasa: 1, 2, 3, 4, 5.',
    );
    expectError(
      () => selectPackage(catalogue(), 'perder-grasa', 2.5, 1),
      'INVALID_DAYS',
    );
  });

  it('rejects month 0, negative and non-integer months', () => {
    for (const mes of [0, -1, 1.5, Number.NaN]) {
      expectError(
        () => selectPackage(catalogue(), 'perder-grasa', 3, mes),
        'INVALID_MONTH',
        'El mes debe ser 1 o superior.',
      );
    }
  });

  it('month 4 has no content and lists the available months', () => {
    expectError(
      () => selectPackage(catalogue(), 'perder-grasa', 3, 4),
      'NO_CONTENT_FOR_MONTH',
      'entrenamiento para el mes 4',
      'Meses disponibles: 1, 2, 3.',
    );
  });

  it('serves a synthetic month 4 once both its block and guide exist', () => {
    const keys = [
      ...catalogue(),
      training('perder-grasa', 'Perder-grasa', '3', '04'),
      guide('perder-grasa', 'Perder-grasa', '04'),
    ];
    expect(selectPackage(keys, 'perder-grasa', 3, 4)).toEqual([
      training('perder-grasa', 'Perder-grasa', '3', '04'),
      guide('perder-grasa', 'Perder-grasa', '04'),
    ]);
  });

  it('reports a missing nutrition guide separately', () => {
    const keys = [
      ...catalogue(),
      training('perder-grasa', 'Perder-grasa', '3', '04'),
    ];
    expectError(
      () => selectPackage(keys, 'perder-grasa', 3, 4),
      'NO_CONTENT_FOR_MONTH',
      'guía de nutrición para el mes 4',
      'Meses disponibles: 1, 2, 3.',
    );
  });

  it('compares block, guide and day numbers numerically (01 vs 10, 1 vs 10)', () => {
    const keys: string[] = [START];
    for (const dias of ['1', '10']) {
      for (const bloque of ['01', '10'])
        keys.push(training('x', 'X', dias, bloque));
    }
    keys.push(guide('x', 'X', '01'), guide('x', 'X', '10'));

    expect(selectPackage(keys, 'x', 1, 1)).toEqual([
      training('x', 'X', '1', '01'),
      guide('x', 'X', '01'),
      START,
    ]);
    expect(selectPackage(keys, 'x', 1, 10)).toEqual([
      training('x', 'X', '1', '10'),
      guide('x', 'X', '10'),
    ]);
    expect(selectPackage(keys, 'x', 10, 10)).toEqual([
      training('x', 'X', '10', '10'),
      guide('x', 'X', '10'),
    ]);
  });

  it('treats zero-padded variants of the same number as the same slot (ambiguous)', () => {
    const keys = [...catalogue(), training('perder-grasa', 'Otro', '3', '1')];
    expectError(
      () => selectPackage(keys, 'perder-grasa', 3, 1),
      'AMBIGUOUS_CONTENT',
      'encontraron 2 de entrenamiento y 1 de nutrición',
    );
    const guides = [...catalogue(), guide('perder-grasa', 'Otro', '2')];
    expectError(
      () => selectPackage(guides, 'perder-grasa', 3, 2),
      'AMBIGUOUS_CONTENT',
      'encontraron 1 de entrenamiento y 2 de nutrición',
    );
  });

  it('requires the start guide for month 1 only', () => {
    const keys = catalogue().filter((key) => key !== START);
    expectError(
      () => selectPackage(keys, 'perder-grasa', 3, 1),
      'MISSING_START_GUIDE',
      'EXOM_Nutricion_Guia-de-inicio.pdf',
    );
    expect(selectPackage(keys, 'perder-grasa', 3, 2)).toHaveLength(2);
  });
});

describe('selectPackage by service scope', () => {
  const block = (bloque: string) =>
    training('perder-grasa', 'Perder-grasa', '3', bloque);
  const nutritionGuide = (guia: string) =>
    guide('perder-grasa', 'Perder-grasa', guia);

  it('maps each scope to the material it includes', () => {
    expect(scopeMaterial(BaseServiceScope.TRAINING)).toEqual({
      training: true,
      nutrition: false,
    });
    expect(scopeMaterial(BaseServiceScope.NUTRITION)).toEqual({
      training: false,
      nutrition: true,
    });
    expect(scopeMaterial(BaseServiceScope.BOTH)).toEqual({
      training: true,
      nutrition: true,
    });
  });

  it('BOTH is the default and selects exactly what was selected before scopes', () => {
    for (const mes of [1, 2]) {
      expect(
        selectPackage(
          catalogue(),
          'perder-grasa',
          3,
          mes,
          BaseServiceScope.BOTH,
        ),
      ).toEqual(selectPackage(catalogue(), 'perder-grasa', 3, mes));
    }
    expect(
      selectPackage(catalogue(), 'perder-grasa', 3, 1, BaseServiceScope.BOTH),
    ).toEqual([block('01'), nutritionGuide('01'), START]);
  });

  it('TRAINING selects only the training block, without the start guide', () => {
    expect(
      selectPackage(
        catalogue(),
        'perder-grasa',
        3,
        1,
        BaseServiceScope.TRAINING,
      ),
    ).toEqual([block('01')]);
    expect(
      selectPackage(
        catalogue(),
        'perder-grasa',
        3,
        2,
        BaseServiceScope.TRAINING,
      ),
    ).toEqual([block('02')]);
  });

  it('NUTRITION selects the nutrition guide and, in month 1, the start guide', () => {
    expect(
      selectPackage(
        catalogue(),
        'perder-grasa',
        3,
        1,
        BaseServiceScope.NUTRITION,
      ),
    ).toEqual([nutritionGuide('01'), START]);
    expect(
      selectPackage(
        catalogue(),
        'perder-grasa',
        3,
        2,
        BaseServiceScope.NUTRITION,
      ),
    ).toEqual([nutritionGuide('02')]);
  });

  it('TRAINING does not need the nutrition guide nor the start guide', () => {
    const keys = catalogue().filter(
      (key) => key !== START && key !== nutritionGuide('01'),
    );
    expect(
      selectPackage(keys, 'perder-grasa', 3, 1, BaseServiceScope.TRAINING),
    ).toEqual([block('01')]);
    expectError(
      () => selectPackage(keys, 'perder-grasa', 3, 1, BaseServiceScope.BOTH),
      'NO_CONTENT_FOR_MONTH',
      'guía de nutrición para el mes 1',
    );
  });

  it('NUTRITION does not need the training block of the month nor those days', () => {
    const keys = [
      ...catalogue().filter((key) => key !== block('02')),
      nutritionGuide('04'),
    ];
    expect(
      selectPackage(keys, 'perder-grasa', 3, 2, BaseServiceScope.NUTRITION),
    ).toEqual([nutritionGuide('02')]);
    expect(
      selectPackage(keys, 'perder-grasa', 6, 4, BaseServiceScope.NUTRITION),
    ).toEqual([nutritionGuide('04')]);
    expectError(
      () => selectPackage(keys, 'perder-grasa', 3, 2, BaseServiceScope.BOTH),
      'NO_CONTENT_FOR_MONTH',
      'entrenamiento para el mes 2',
    );
  });

  it('still validates the goal and the month for every scope', () => {
    for (const scope of Object.values(BaseServiceScope)) {
      expectError(
        () => selectPackage(catalogue(), 'nope', 3, 1, scope),
        'INVALID_GOAL',
      );
      expectError(
        () => selectPackage(catalogue(), 'perder-grasa', 3, 0, scope),
        'INVALID_MONTH',
      );
    }
    expectError(
      () =>
        selectPackage(
          catalogue(),
          'perder-grasa',
          6,
          1,
          BaseServiceScope.TRAINING,
        ),
      'INVALID_DAYS',
    );
  });

  it('reports missing material of the included area only', () => {
    expectError(
      () =>
        selectPackage(
          catalogue(),
          'perder-grasa',
          3,
          4,
          BaseServiceScope.TRAINING,
        ),
      'NO_CONTENT_FOR_MONTH',
      'entrenamiento para el mes 4',
    );
    expectError(
      () =>
        selectPackage(
          catalogue(),
          'perder-grasa',
          3,
          4,
          BaseServiceScope.NUTRITION,
        ),
      'NO_CONTENT_FOR_MONTH',
      'guía de nutrición para el mes 4',
    );
    const noStart = catalogue().filter((key) => key !== START);
    expectError(
      () =>
        selectPackage(
          noStart,
          'perder-grasa',
          3,
          1,
          BaseServiceScope.NUTRITION,
        ),
      'MISSING_START_GUIDE',
    );
  });

  it('only an ambiguous slot of the included area is ambiguous', () => {
    const keys = [...catalogue(), guide('perder-grasa', 'Otro', '2')];
    expect(
      selectPackage(keys, 'perder-grasa', 3, 2, BaseServiceScope.TRAINING),
    ).toEqual([block('02')]);
    expectError(
      () =>
        selectPackage(keys, 'perder-grasa', 3, 2, BaseServiceScope.NUTRITION),
      'AMBIGUOUS_CONTENT',
      'encontraron 2 de nutrición',
    );
  });

  it('never returns an empty selection: no material at all is EMPTY_PACKAGE', () => {
    expectError(
      () =>
        selectPackageFor(catalogue(), 'perder-grasa', 3, 1, {
          training: false,
          nutrition: false,
        }),
      'EMPTY_PACKAGE',
    );
  });
});

describe('listRoutes', () => {
  it('lists, per goal, the days and the deliverable months', () => {
    expect(listRoutes(catalogue())).toEqual([
      {
        objetivo: 'ganar-fuerza',
        dias: [1, 2, 3, 4, 5],
        months: [1, 2, 3],
        monthsByDias: [1, 2, 3, 4, 5].map((dias) => ({
          dias,
          months: [1, 2, 3],
        })),
      },
      {
        objetivo: 'perder-grasa',
        dias: [1, 2, 3, 4, 5],
        months: [1, 2, 3],
        monthsByDias: [1, 2, 3, 4, 5].map((dias) => ({
          dias,
          months: [1, 2, 3],
        })),
      },
    ]);
  });

  it('only counts months where both the block and the guide exist', () => {
    const keys = [
      ...catalogue().filter(
        (key) => key !== guide('ganar-fuerza', 'Fuerza', '03'),
      ),
      training('perder-grasa', 'Perder-grasa', '3', '04'),
      guide('perder-grasa', 'Perder-grasa', '04'),
      guide('perder-grasa', 'Perder-grasa', '05'),
    ];
    const routes = listRoutes(keys);
    const fuerza = routes.find((route) => route.objetivo === 'ganar-fuerza');
    const grasa = routes.find((route) => route.objetivo === 'perder-grasa');

    expect(fuerza?.months).toEqual([1, 2]);
    expect(grasa?.months).toEqual([1, 2, 3]);
    expect(
      grasa?.monthsByDias.find((entry) => entry.dias === 3)?.months,
    ).toEqual([1, 2, 3, 4]);
  });

  it('excludes month 1 without a start guide and ambiguous months', () => {
    const keys = [
      ...catalogue().filter((key) => key !== START),
      training('perder-grasa', 'Otro', '3', '2'),
    ];
    const grasa = listRoutes(keys).find(
      (route) => route.objetivo === 'perder-grasa',
    );
    expect(
      grasa?.monthsByDias.find((entry) => entry.dias === 3)?.months,
    ).toEqual([3]);
    expect(
      grasa?.monthsByDias.find((entry) => entry.dias === 2)?.months,
    ).toEqual([2, 3]);
    // `months` only keeps the months deliverable for every listed day count.
    expect(grasa?.months).toEqual([3]);
  });

  it('returns an empty list for an empty catalogue', () => {
    expect(listRoutes([])).toEqual([]);
  });
});
