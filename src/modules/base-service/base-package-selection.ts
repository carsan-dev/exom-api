import { BaseServiceError } from './base-service.error';

/**
 * Selection of the monthly base-service package from a flat list of source
 * keys (relative POSIX paths), ported from exom-base-pdfs/entrega.py
 * (`select_package`). Goals, day counts and months are discovered from the
 * keys; nothing is hardcoded.
 *
 * Layout:
 *   entrenamiento/<objetivo>/EXOM_Entrenamiento_<X>_<N>-dias_Bloque-<BB>.pdf
 *   nutricion/<objetivo>/EXOM_Nutricion_<X>_Guia-<BB>.pdf
 *   nutricion/EXOM_Nutricion_Guia-de-inicio.pdf
 */

export const START_GUIDE_NAME = 'EXOM_Nutricion_Guia-de-inicio.pdf';
export const START_GUIDE_KEY = `nutricion/${START_GUIDE_NAME}`;

const TRAINING_RE =
  /^EXOM_Entrenamiento_(?<label>.+)_(?<dias>[0-9]+)-dias_Bloque-(?<bloque>[0-9]+)\.pdf$/;
const NUTRITION_RE = /^EXOM_Nutricion_(?<label>.+)_Guia-(?<guia>[0-9]+)\.pdf$/;

interface TrainingEntry {
  key: string;
  dias: number;
  bloque: number;
}

interface GuideEntry {
  key: string;
  guia: number;
}

interface Catalogue {
  objetivos: string[];
  training: Map<string, TrainingEntry[]>;
  nutrition: Map<string, GuideEntry[]>;
  hasStartGuide: boolean;
}

export interface BaseRouteMonths {
  dias: number;
  months: number[];
}

export interface BaseRoute {
  objetivo: string;
  /** Day counts with at least one training block. */
  dias: number[];
  /** Months deliverable for every listed day count. */
  months: number[];
  /** Months deliverable per day count. */
  monthsByDias: BaseRouteMonths[];
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function parseCatalogue(keys: readonly string[]): Catalogue {
  const objetivos = new Set<string>();
  const training = new Map<string, TrainingEntry[]>();
  const nutrition = new Map<string, GuideEntry[]>();
  let hasStartGuide = false;

  // Sorted like the reference, which iterates directory entries in order.
  for (const key of [...keys].sort(compareStrings)) {
    const parts = key.split('/');
    if (parts.length === 2 && parts[0] === 'nutricion') {
      if (parts[1] === START_GUIDE_NAME) hasStartGuide = true;
      continue;
    }
    if (parts.length !== 3 || !parts[1] || !parts[2]) continue;
    const [area, objetivo, filename] = parts;
    if (area === 'entrenamiento') {
      objetivos.add(objetivo);
      const groups = TRAINING_RE.exec(filename)?.groups;
      if (groups) {
        pushTo(training, objetivo, {
          key,
          dias: Number(groups.dias),
          bloque: Number(groups.bloque),
        });
      }
    } else if (area === 'nutricion') {
      const groups = NUTRITION_RE.exec(filename)?.groups;
      if (groups) {
        pushTo(nutrition, objetivo, { key, guia: Number(groups.guia) });
      }
    }
  }

  return {
    objetivos: [...objetivos].sort(compareStrings),
    training,
    nutrition,
    hasStartGuide,
  };
}

function joinOrNone(values: readonly (string | number)[]): string {
  return values.length > 0 ? values.join(', ') : 'ninguno';
}

function selectFromCatalogue(
  catalogue: Catalogue,
  objetivo: string,
  dias: number,
  mes: number,
): string[] {
  if (catalogue.objetivos.length === 0) {
    throw new BaseServiceError(
      'EMPTY_CATALOG',
      'No hay contenido de entrenamiento en el origen.',
    );
  }
  if (!catalogue.objetivos.includes(objetivo)) {
    throw new BaseServiceError(
      'INVALID_GOAL',
      `Objetivo no válido: «${objetivo}». Disponibles: ${catalogue.objetivos.join(', ')}.`,
    );
  }

  const training = catalogue.training.get(objetivo) ?? [];
  const diasFound = sortedNumbers(training.map((entry) => entry.dias));
  if (!diasFound.includes(dias)) {
    throw new BaseServiceError(
      'INVALID_DAYS',
      `Días por semana no válidos: ${dias}. Disponibles para ${objetivo}: ${diasFound.join(', ')}.`,
    );
  }
  if (!Number.isInteger(mes) || mes < 1) {
    throw new BaseServiceError(
      'INVALID_MONTH',
      'El mes debe ser 1 o superior.',
    );
  }

  const blocks = training.filter((entry) => entry.dias === dias);
  const train = blocks.filter((entry) => entry.bloque === mes);
  if (train.length === 0) {
    const blockMonths = sortedNumbers(blocks.map((entry) => entry.bloque));
    throw new BaseServiceError(
      'NO_CONTENT_FOR_MONTH',
      `Todavía no hay contenido de entrenamiento para el mes ${mes} ` +
        `(${objetivo}, ${dias} días). Meses disponibles: ${joinOrNone(blockMonths)}.`,
    );
  }

  const nutrition = catalogue.nutrition.get(objetivo) ?? [];
  const guide = nutrition.filter((entry) => entry.guia === mes);
  if (guide.length === 0) {
    const guideMonths = sortedNumbers(nutrition.map((entry) => entry.guia));
    throw new BaseServiceError(
      'NO_CONTENT_FOR_MONTH',
      `Todavía no hay guía de nutrición para el mes ${mes} (${objetivo}). ` +
        `Meses disponibles: ${joinOrNone(guideMonths)}.`,
    );
  }
  if (train.length !== 1 || guide.length !== 1) {
    throw new BaseServiceError(
      'AMBIGUOUS_CONTENT',
      `Se esperaba un único archivo por apartado para el mes ${mes} y se ` +
        `encontraron ${train.length} de entrenamiento y ${guide.length} de nutrición.`,
    );
  }

  const files = [train[0].key, guide[0].key];
  if (mes === 1) {
    if (!catalogue.hasStartGuide) {
      throw new BaseServiceError(
        'MISSING_START_GUIDE',
        `Falta la guía de inicio (${START_GUIDE_NAME}).`,
      );
    }
    files.push(START_GUIDE_KEY);
  }
  return files;
}

/**
 * Returns the ordered source keys for (objetivo, dias, mes): training block,
 * nutrition guide and, for month 1, the start guide. Throws
 * {@link BaseServiceError} when the route is invalid or a slot has no content
 * or more than one match.
 */
export function selectPackage(
  keys: readonly string[],
  objetivo: string,
  dias: number,
  mes: number,
): string[] {
  return selectFromCatalogue(parseCatalogue(keys), objetivo, dias, mes);
}

function isDeliverable(
  catalogue: Catalogue,
  objetivo: string,
  dias: number,
  mes: number,
): boolean {
  try {
    selectFromCatalogue(catalogue, objetivo, dias, mes);
    return true;
  } catch (error) {
    if (error instanceof BaseServiceError) return false;
    throw error;
  }
}

/**
 * Lists, per goal, the available day counts and the months for which
 * {@link selectPackage} would succeed (both the training block and the
 * nutrition guide exist, unambiguously, and the start guide for month 1).
 */
export function listRoutes(keys: readonly string[]): BaseRoute[] {
  const catalogue = parseCatalogue(keys);
  return catalogue.objetivos.map((objetivo) => {
    const training = catalogue.training.get(objetivo) ?? [];
    const guideMonths = new Set(
      (catalogue.nutrition.get(objetivo) ?? []).map((entry) => entry.guia),
    );
    const dias = sortedNumbers(training.map((entry) => entry.dias));
    const monthsByDias = dias.map((count) => ({
      dias: count,
      months: sortedNumbers(
        training
          .filter((entry) => entry.dias === count)
          .map((entry) => entry.bloque),
      ).filter(
        (mes) =>
          guideMonths.has(mes) &&
          isDeliverable(catalogue, objetivo, count, mes),
      ),
    }));
    const months =
      monthsByDias.length === 0
        ? []
        : monthsByDias[0].months.filter((mes) =>
            monthsByDias.every((entry) => entry.months.includes(mes)),
          );
    return { objetivo, dias, months, monthsByDias };
  });
}
