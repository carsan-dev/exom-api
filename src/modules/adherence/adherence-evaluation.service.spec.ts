import {
  COMPLETION,
  evaluateDailyAdherence,
} from '../../common/progress/daily-adherence-evaluator';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AdherencePrescriptionService } from './adherence-prescription.service';
import {
  AdherenceEvaluationService,
  BASIS_DIGEST_PREFIX,
  basisDigest,
  canonicalFallbackBasis,
  fallbackBasisDigest,
  frozenDay,
  normalizeAdherenceEvidence,
  type EvaluationBasis,
} from './adherence-evaluation.service';
import { AdherencePeriodQueryDto } from './dto/adherence-period-query.dto';

const basis = {
  trainingKnown: true,
  rest: false,
  units: [{ id: 'link', trainingId: 'training', occurrences: ['occurrence'] }],
  nutritionKnown: true,
  groups: [
    {
      id: 'root',
      alternatives: [
        { id: 'root', ingredients: [] },
        { id: 'alt', ingredients: [] },
      ],
    },
  ],
  calories: 100,
  protein: 10,
};
const date = new Date('2020-01-01T00:00:00Z');
const progress = {
  client_id: 'client',
  date,
  sync_revision: 1,
  training_completed: true,
  trainings_completed: ['training'],
  training_sessions: [
    {
      training_session_id: 'session',
      training_id: 'training',
      rpe: 8,
      note: null,
    },
  ],
  exercises_completed: [
    {
      training_session_id: 'session',
      training_exercise_id: 'occurrence',
      exercise_id: 'exercise',
      completed_at: '2020-01-01T12:00:00Z',
    },
  ],
  meals_completed: ['alt'],
};
function receipt() {
  return [
    {
      id: 'operation',
      owner_id: 'client',
      date,
      response: {
        ...progress,
        date: date.toISOString(),
        operation_revision: 1,
      },
    },
  ];
}
describe('basis digests (ADH-FREEZE-01 U2)', () => {
  const assigned: EvaluationBasis = {
    trainingKnown: true,
    rest: false,
    completionMode: 'ALL',
    units: [{ id: 'link', trainingId: 'training', occurrences: ['a', 'b'] }],
    nutritionKnown: true,
    groups: [
      {
        id: 'root',
        alternatives: [
          {
            id: 'alt',
            ingredients: [
              {
                quantity: 50,
                unit: 'g',
                grams_equivalent: null,
                ingredient: { calories_per_100g: 130, protein_per_100g: 7 },
              },
            ],
          },
          { id: 'root', ingredients: [] },
        ],
      },
    ],
    calories: 1800,
    protein: 90,
  };
  const unassigned: EvaluationBasis = {
    trainingKnown: true,
    rest: false,
    units: [],
    nutritionKnown: true,
    groups: [],
    calories: null,
    protein: null,
  };
  const rest: EvaluationBasis = {
    ...unassigned,
    rest: true,
    completionMode: 'ANY',
    calories: 2000,
    protein: 100.5,
  };
  // Values computed with the code of develop 905a0b7, before U2: persisted
  // current_fallback revision keys must not change byte for byte.
  it.each([
    [
      'assigned ALL',
      assigned,
      '55490098ef8f2c4379c7106fd99b6e3b656814664c23b22e7aaa3db71c52d563',
    ],
    [
      'unassigned',
      unassigned,
      'a531ec2f3962ce9e714f3d7d9788a724367b32920045b9dbd357f8e4c337049c',
    ],
    [
      'rest ANY',
      rest,
      '07e0b1ef187e9927c59326c0760c4d225e73f8461069f85ff357e50ab59d5726',
    ],
  ])('keeps the current_fallback digest of %s', (_name, value, hash) => {
    expect(fallbackBasisDigest(value)).toBe('current_fallback:v1:' + hash);
    expect(basisDigest(BASIS_DIGEST_PREFIX.CURRENT_FALLBACK, value)).toBe(
      'current_fallback:v1:' + hash,
    );
    expect(basisDigest(BASIS_DIGEST_PREFIX.FROZEN_DAY, value)).toBe(
      'frozen_day:v1:' + hash,
    );
  });
});

describe('frozen day row validation (ADH-FREEZE-01 U2)', () => {
  const unit = { id: 'link', training_id: 'training', occurrences: ['b', 'a'] };
  const valid = {
    version: 1,
    assigned: true,
    assignment_id: 'assignment',
    rest: false,
    completion_mode: 'ANY',
    diet_id: 'diet',
    units: [unit],
  };
  const row = (basis: unknown, extra: Record<string, unknown> = {}) => ({
    version: 1,
    provenance: 'scheduled',
    basis,
    ...extra,
  });
  it('reads an assigned row with its mode, diet and units', () => {
    expect(frozenDay(row(valid))).toEqual({
      provenance: 'scheduled',
      plan: {
        assigned: true,
        rest: false,
        completionMode: 'ANY',
        dietId: 'diet',
        units: [
          { id: 'link', trainingId: 'training', occurrences: ['b', 'a'] },
        ],
      },
    });
  });
  it('reads "not assigned", a rest day with its mode, a null diet and a late row', () => {
    expect(frozenDay(row({ version: 1, assigned: false }))).toEqual({
      provenance: 'scheduled',
      plan: { assigned: false },
    });
    expect(
      frozenDay(
        row(
          { ...valid, rest: true, units: [], diet_id: null },
          { provenance: 'late' },
        ),
      ),
    ).toEqual({
      provenance: 'late',
      plan: {
        assigned: true,
        rest: true,
        completionMode: 'ANY',
        dietId: null,
        units: [],
      },
    });
  });
  it.each([
    ['row version 2', row(valid, { version: 2 })],
    ['row version as text', row(valid, { version: '1' })],
    ['unknown provenance', row(valid, { provenance: 'manual' })],
    ['null basis', row(null)],
    ['array basis', row([valid])],
    ['basis version 2', row({ ...valid, version: 2 })],
    ['missing assigned', row({ version: 1 })],
    ['assigned as text', row({ ...valid, assigned: 'true' })],
    ['missing rest', row({ ...valid, rest: undefined })],
    ['completion mode SOME', row({ ...valid, completion_mode: 'SOME' })],
    ['lowercase completion mode', row({ ...valid, completion_mode: 'any' })],
    ['missing diet id', row({ ...valid, diet_id: undefined })],
    ['numeric diet id', row({ ...valid, diet_id: 3 })],
    ['units not an array', row({ ...valid, units: {} })],
    ['unit without id', row({ ...valid, units: [{ ...unit, id: undefined }] })],
    [
      'unit without training',
      row({ ...valid, units: [{ ...unit, training_id: null }] }),
    ],
    [
      'occurrences not an array',
      row({ ...valid, units: [{ ...unit, occurrences: 'a' }] }),
    ],
    [
      'non-text occurrence',
      row({ ...valid, units: [{ ...unit, occurrences: ['a', 2] }] }),
    ],
    ['unit not an object', row({ ...valid, units: ['link'] })],
    ['rest day with units', row({ ...valid, rest: true })],
  ])('rejects a row with %s', (_name, value) => {
    expect(frozenDay(value)).toBeNull();
  });
});

describe('recent closed service collection', () => {
  it.each([
    ['2020-01-01', '2020-01-01', 7],
    ['2030-01-01', '2030-01-31', 38],
    ['2020-01-02', '2020-01-02', 8],
  ])(
    'keeps public days bounded while collecting original history for %s..%s',
    async (start, end, count) => {
      const read = jest
        .spyOn(AdherencePrescriptionService.prototype, 'readMany')
        .mockResolvedValue(new Map());
      const current = jest.fn().mockResolvedValue(null);
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        user: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'client',
              role: 'CLIENT',
              is_active: true,
              is_locked: false,
              is_archived: false,
              identity_pending: false,
            },
          ]),
        },
        planAssignment: { findUnique: current },
        weeklyRecap: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        dayProgress: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        progressOperation: { findMany: jest.fn().mockResolvedValue([]) },
        adherenceEvaluationRevision: {
          findUnique: jest.fn().mockResolvedValue(null),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
      };
      class FixedEvaluation extends AdherenceEvaluationService {
        protected override utcInstant() {
          return new Date('2020-01-02T12:00:00Z');
        }
      }
      const module = await Test.createTestingModule({
        providers: [
          { provide: AdherenceEvaluationService, useClass: FixedEvaluation },
          {
            provide: PrismaService,
            useValue: {
              $transaction: (run: (value: typeof tx) => Promise<unknown>) =>
                run(tx),
            },
          },
        ],
      }).compile();
      try {
        const service = module.get(AdherenceEvaluationService);
        const result = await service.get('client', 'CLIENT', 'client', {
          start,
          end,
        });
        expect(result.days.map((day) => day.date)).toEqual(
          AdherencePeriodQueryDto.dates(start, end),
        );
        expect(
          result.days.length +
            read.mock.calls[0][1].filter((date) => date < start).length,
        ).toBe(count);
        expect(result.recentClosed).toMatchObject({
          start: '2019-12-26',
          end: '2020-01-01',
          status: 'insufficient',
          configuration: { known: false, low_global_percent: null },
        });
        expect(result.recentClosed.aggregate.global.ratio).toBeNull();
        expect(
          read.mock.calls.every(
            ([owner, dates]) =>
              owner === 'client' && dates.every((date) => date < '2020-01-02'),
          ),
        ).toBe(true);
        expect(current).toHaveBeenCalledTimes(start === '2020-01-02' ? 1 : 0);
        expect(tx.dayProgress.findUnique).not.toHaveBeenCalled();
        expect(tx.dayProgress.findMany).toHaveBeenCalledTimes(1);
        expect(tx.progressOperation.findMany).toHaveBeenCalledTimes(1);
        expect(tx.weeklyRecap.findMany).toHaveBeenCalledTimes(1);
        const evidenceDates = [
          ...new Set([
            ...AdherencePeriodQueryDto.dates(start, end),
            ...AdherencePeriodQueryDto.dates('2019-12-26', '2020-01-01'),
          ]),
        ]
          .filter((date) => date <= '2020-01-02')
          .sort();
        expect(tx.dayProgress.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              client_id: 'client',
              date: { in: evidenceDates.map((date) => new Date(date)) },
            },
          }),
        );
        expect(tx.progressOperation.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              owner_id: 'client',
              date: { in: evidenceDates.map((date) => new Date(date)) },
            },
            orderBy: { id: 'asc' },
          }),
        );
        const collected = [
          ...new Set([
            ...AdherencePeriodQueryDto.dates(start, end),
            ...AdherencePeriodQueryDto.dates('2019-12-26', '2020-01-01'),
          ]),
        ].sort();
        const weekStarts = [
          ...new Set(
            collected.map((date) => {
              const at = new Date(date);
              at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
              return at.toISOString();
            }),
          ),
        ];
        expect(tx.weeklyRecap.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              client_id: 'client',
              submitted_at: { not: null },
              status: { in: ['SUBMITTED', 'REVIEWED'] },
              OR: weekStarts.map((start) => ({
                week_start_date: new Date(start),
                week_end_date: new Date(Date.parse(start) + 6 * 86400000),
              })),
            },
          }),
        );
        expect(result.weeks).toHaveLength(
          new Set(
            AdherencePeriodQueryDto.dates(start, end).map((date) => {
              const at = new Date(date);
              at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
              return at.toISOString().slice(0, 10);
            }),
          ).size,
        );
        const readsBeforeDenial = read.mock.calls.length;
        await expect(
          service.get('other', 'CLIENT', 'client', { start, end }),
        ).rejects.toThrow('Client access denied');
        expect(read).toHaveBeenCalledTimes(readsBeforeDenial);
      } finally {
        read.mockRestore();
        await module.close();
      }
    },
  );
});

describe('actual progress normalization and bounded UTC period', () => {
  it('credits exact session/occurrence and replacement root claim from owner/day receipt', () => {
    const result = normalizeAdherenceEvidence(
      basis,
      progress,
      receipt(),
      'client',
      '2020-01-01',
    );
    expect(result.training[0].completion).toBe(COMPLETION.COMPLETE);
    expect(result.nutrition[0].completion).toBe(COMPLETION.COMPLETE);
  });
  it('does not invent credit from unsupported legacy flags', () => {
    const result = normalizeAdherenceEvidence(
      basis,
      { ...progress, training_sessions: [], exercises_completed: [] },
      [],
      'client',
      '2020-01-01',
    );
    expect(result.training[0].completion).toBe(COMPLETION.INDETERMINATE);
  });
  it('excludes ambiguous global legacy completion across multiple frozen sessions', () => {
    const multiple = {
      ...basis,
      units: [
        ...basis.units,
        {
          id: 'second',
          trainingId: 'other',
          occurrences: ['other-occurrence'],
        },
      ],
    };
    const result = normalizeAdherenceEvidence(
      multiple,
      {
        ...progress,
        trainings_completed: [],
        training_sessions: [],
        exercises_completed: [],
      },
      [],
      'client',
      '2020-01-01',
    );
    expect(result.training.map((unit) => unit.completion)).toEqual([
      COMPLETION.INDETERMINATE,
      COMPLETION.INDETERMINATE,
    ]);
  });
  it.each(['other', '2020-01-02'])(
    'rejects foreign owner or day %s',
    (value) => {
      const result = normalizeAdherenceEvidence(
        basis,
        progress,
        receipt(),
        value === 'other' ? value : 'client',
        value === 'other' ? '2020-01-01' : value,
      );
      expect(result.training[0].completion).not.toBe(COMPLETION.COMPLETE);
      expect(result.nutrition[0].completion).not.toBe(COMPLETION.COMPLETE);
    },
  );
  it('rejects colliding session claimed by two trainings', () => {
    const collision = {
      ...progress,
      training_sessions: [
        ...progress.training_sessions,
        {
          training_session_id: 'session',
          training_id: 'other',
          rpe: 8,
          note: null,
        },
      ],
    };
    expect(
      normalizeAdherenceEvidence(basis, collision, [], 'client', '2020-01-01')
        .training[0].completion,
    ).not.toBe(COMPLETION.COMPLETE);
  });
  it('does not double-credit root and alternative collisions', () => {
    const collision = { ...progress, meals_completed: ['root', 'alt'] };
    expect(
      normalizeAdherenceEvidence(basis, collision, [], 'client', '2020-01-01')
        .nutrition[0].completion,
    ).toBe(COMPLETION.INDETERMINATE);
  });
  it('validates a strict civil range of at most 31 days', () => {
    expect(
      AdherencePeriodQueryDto.dates('2020-02-01', '2020-03-02'),
    ).toHaveLength(31);
    expect(() =>
      AdherencePeriodQueryDto.dates('2020-02-01', '2020-03-03'),
    ).toThrow();
    expect(() =>
      AdherencePeriodQueryDto.dates('2020-02-30', '2020-03-02'),
    ).toThrow();
    expect(() =>
      AdherencePeriodQueryDto.dates('2020-02-01T00:00:00Z', '2020-03-02'),
    ).toThrow();
  });
});

describe('training completion mode in adherence', () => {
  const units = ['1', '2', '3'].map((n) => ({
    id: `link-${n}`,
    trainingId: `training-${n}`,
    occurrences: [`occurrence-${n}`],
  }));
  const oneOfThreeProven = {
    ...progress,
    training_completed: true,
    trainings_completed: ['training-2'],
    training_sessions: [
      {
        training_session_id: 'session-2',
        training_id: 'training-2',
        rpe: 7,
        note: null,
      },
    ],
    exercises_completed: [
      {
        training_session_id: 'session-2',
        training_exercise_id: 'occurrence-2',
        exercise_id: 'exercise-2',
        completed_at: '2020-01-01T12:00:00Z',
      },
    ],
  };
  const evaluate = (
    completionMode: 'ALL' | 'ANY' | undefined,
    evidence: Parameters<typeof normalizeAdherenceEvidence>[1],
  ) =>
    evaluateDailyAdherence({
      date: '2020-01-01',
      cutoffDate: '2020-01-02',
      training: {
        basis: 'known',
        rest: false,
        units: normalizeAdherenceEvidence(
          { ...basis, units, completionMode },
          evidence,
          [],
          'client',
          '2020-01-01',
        ).training,
      },
      nutrition: { basis: 'known', groups: [] },
    }).training;

  it('rates an ANY day with one proven training as 1/1 without caveats', () => {
    expect(evaluate('ANY', oneOfThreeProven)).toMatchObject({
      numerator: 1,
      denominator: 1,
      ratio: 1,
      caveats: [],
    });
  });

  it('rates an ANY day without any training as 0/1', () => {
    expect(
      evaluate('ANY', {
        ...progress,
        training_completed: false,
        trainings_completed: [],
        training_sessions: [],
        exercises_completed: [],
      }),
    ).toMatchObject({ numerator: 0, denominator: 1, ratio: 0 });
  });

  it('keeps an unproven ANY day flag indeterminate (2026-09-29)', () => {
    expect(
      evaluate('ANY', {
        ...progress,
        training_completed: true,
        trainings_completed: [],
        training_sessions: [],
        exercises_completed: [],
      }),
    ).toMatchObject({
      denominator: 0,
      ratio: null,
      caveats: ['indeterminate_training'],
    });
  });

  it.each([undefined, 'ALL'] as const)(
    'keeps per-unit ALL semantics (mode %s) unchanged',
    (mode) => {
      const units3 = normalizeAdherenceEvidence(
        { ...basis, units, completionMode: mode },
        oneOfThreeProven,
        [],
        'client',
        '2020-01-01',
      ).training;
      // Legacy day flag still marks the unproven units indeterminate.
      expect(units3.map((unit) => [unit.id, unit.completion])).toEqual([
        ['link-1', COMPLETION.INDETERMINATE],
        ['link-2', COMPLETION.COMPLETE],
        ['link-3', COMPLETION.INDETERMINATE],
      ]);
    },
  );

  it('treats an ANY day with a single training exactly like ALL', () => {
    const single = { ...basis, units: [units[0]] };
    const evidence = {
      ...progress,
      training_sessions: [],
      exercises_completed: [],
    };
    expect(
      normalizeAdherenceEvidence(
        { ...single, completionMode: 'ANY' },
        evidence,
        [],
        'client',
        '2020-01-01',
      ).training,
    ).toEqual(
      normalizeAdherenceEvidence(single, evidence, [], 'client', '2020-01-01')
        .training,
    );
  });
});

// ADH-RESPALDO-PAUTA-ACTUAL (owner decision 2026-11-17): a closed day with no
// published original prescription row is evaluated with the current plan of
// that date and labelled `current_fallback`; a published original still wins.
describe('closed-day current-plan fallback', () => {
  const day = '2020-01-01';
  const window = AdherencePeriodQueryDto.dates('2019-12-26', day);
  type Assignment = Record<string, unknown> | null;
  function assignment(mode = 'ALL', occurrences = ['occurrence']) {
    return {
      id: 'assignment',
      client_id: 'client',
      date,
      diet_id: 'diet',
      is_rest_day: false,
      training_completion_mode: mode,
      trainings: [
        {
          id: 'link',
          training_id: 'training',
          training: { exercises: occurrences.map((id) => ({ id })) },
        },
      ],
      training: null,
      diet: {
        total_calories: 100,
        total_protein_g: 10,
        meals: [
          {
            id: 'root',
            parent_meal_id: null,
            name: 'Root',
            ingredients: [],
            variants: [{ id: 'alt', parent_meal_id: 'root', ingredients: [] }],
          },
        ],
      },
    };
  }
  const policy = (at: string) => ({
    date: at,
    id: 'config',
    version: 1,
    effective_date: '2019-01-01',
    steps_goal: 1000,
    steps_min_percent: 100,
    calorie_lower_percent: 10,
    calorie_upper_percent: 10,
    protein_min_percent: 90,
    low_global_percent: 80,
  });
  function sqlText(value: unknown): string {
    if (Array.isArray(value)) return value.join('?');
    if (value && typeof value === 'object' && 'strings' in value) {
      const strings = (value as { strings: unknown }).strings;
      return Array.isArray(strings) ? strings.join('?') : '';
    }
    return '';
  }
  function sqlValues(value: unknown): unknown[] {
    if (value && typeof value === 'object' && 'values' in value) {
      const values = (value as { values: unknown }).values;
      return Array.isArray(values) ? (values as unknown[]) : [];
    }
    return [];
  }
  async function harness(options: {
    plan: (at: string) => Assignment;
    originals?: Map<string, unknown>;
    dayProgress?: unknown[];
    latest?: number | null;
    /** adherence_day_bases rows by date (ADH-FREEZE-01 U2). */
    frozen?: Map<
      string,
      { version: unknown; provenance: unknown; basis: unknown }
    >;
    /** diet_day_snapshots rows returned to loadDietHistory. */
    dietHistory?: unknown[];
    /** Catalog diets returned to diet.findMany by id. */
    diets?: Array<{ id: string } & Record<string, unknown>>;
    /** Requested period; defaults to the single closed fixture day. */
    range?: { start: string; end: string };
    /** Persisted revisions by idempotency key, shared across reads. */
    store?: Map<string, { evaluation: unknown; revision: number }>;
  }) {
    const read = jest
      .spyOn(AdherencePrescriptionService.prototype, 'readMany')
      .mockImplementation((_client, dates) =>
        Promise.resolve(
          new Map(
            dates.map((at) => [
              at,
              (options.originals?.get(at) ?? {
                status: 'unknown',
                reason: 'missing_stored_basis',
              }) as never,
            ]),
          ),
        ),
      );
    const current = jest.fn(
      (args: {
        where: { client_id_date: { client_id: string; date: Date } };
      }) =>
        Promise.resolve(
          options.plan(
            args.where.client_id_date.date.toISOString().slice(0, 10),
          ),
        ),
    );
    // Closed fallback dates load their plans in one batch: a findFirst probe,
    // then findMany only if some date has a plan. Each returned assignment
    // carries its own date, as PostgreSQL would.
    type BatchArgs = { where: { client_id: string; date: { in: Date[] } } };
    const plansFor = (args: BatchArgs) =>
      args.where.date.in.flatMap((at) => {
        const plan = options.plan(at.toISOString().slice(0, 10));
        return plan ? [{ ...plan, date: at }] : [];
      });
    const probe = jest.fn((args: BatchArgs) =>
      Promise.resolve(plansFor(args)[0] ?? null),
    );
    const batch = jest.fn((args: BatchArgs) => Promise.resolve(plansFor(args)));
    type RevisionWrite = {
      data: { idempotency_key: string; evaluation: unknown; revision: number };
    };
    const create = jest.fn((args: RevisionWrite) => {
      options.store?.set(args.data.idempotency_key, {
        evaluation: args.data.evaluation,
        revision: args.data.revision,
      });
      return Promise.resolve({});
    });
    type RevisionLookup = {
      where: { client_id_date_idempotency_key: { idempotency_key: string } };
    };
    const findUnique = jest.fn((args: RevisionLookup) =>
      Promise.resolve(
        options.store?.get(
          args.where.client_id_date_idempotency_key.idempotency_key,
        ) ?? null,
      ),
    );
    // Like PostgreSQL, an is_active filter (if the service ever sent one)
    // would hide inactive catalog diets.
    const dietCatalog = jest.fn(
      (args: { where: { id: { in: string[] }; is_active?: boolean } }) =>
        Promise.resolve(
          (options.diets ?? []).filter(
            (diet) =>
              args.where.id.in.includes(diet.id) &&
              (args.where.is_active === undefined ||
                diet.is_active === args.where.is_active),
          ),
        ),
    );
    const tx = {
      $queryRaw: jest.fn((query: unknown) => {
        const text = sqlText(query);
        if (text.includes('adherence_config_revisions'))
          return Promise.resolve(
            AdherencePeriodQueryDto.dates('2019-12-23', '2020-01-05').map(
              policy,
            ),
          );
        // Like PostgreSQL, only the requested dates' rows come back.
        if (text.includes('adherence_day_bases')) {
          const requested = sqlValues(query);
          return Promise.resolve(
            [...(options.frozen?.entries() ?? [])]
              .filter(([at]) => requested.includes(at))
              .map(([at, row]) => ({ date: at, ...row })),
          );
        }
        if (text.includes('diet_day_snapshots'))
          return Promise.resolve(options.dietHistory ?? []);
        return Promise.resolve([]);
      }),
      diet: { findMany: dietCatalog },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'client',
            role: 'CLIENT',
            is_active: true,
            is_locked: false,
            is_archived: false,
            identity_pending: false,
          },
        ]),
      },
      planAssignment: {
        findUnique: current,
        findMany: batch,
        findFirst: probe,
      },
      weeklyRecap: { findMany: jest.fn().mockResolvedValue([]) },
      dayProgress: {
        findMany: jest.fn().mockResolvedValue(options.dayProgress ?? []),
      },
      progressOperation: { findMany: jest.fn().mockResolvedValue([]) },
      adherenceEvaluationRevision: {
        findUnique,
        findFirst: jest
          .fn()
          .mockResolvedValue(
            options.latest ? { revision: options.latest } : null,
          ),
        create,
      },
    };
    class FixedEvaluation extends AdherenceEvaluationService {
      protected override utcInstant() {
        return new Date('2020-01-02T12:00:00Z');
      }
    }
    const module = await Test.createTestingModule({
      providers: [
        { provide: AdherenceEvaluationService, useClass: FixedEvaluation },
        {
          provide: PrismaService,
          useValue: {
            $transaction: (run: (value: typeof tx) => Promise<unknown>) =>
              run(tx),
          },
        },
      ],
    }).compile();
    try {
      const result = await module
        .get(AdherenceEvaluationService)
        .get(
          'client',
          'CLIENT',
          'client',
          options.range ?? { start: day, end: day },
        );
      return {
        result,
        create,
        findUnique,
        current,
        probe,
        batch,
        raw: tx.$queryRaw,
        dietCatalog,
      };
    } finally {
      read.mockRestore();
      await module.close();
    }
  }
  interface CreatedRow {
    date: Date;
    revision: number;
    original_basis_id: string | null;
    original_basis_digest: string;
    cut_binding: string | null;
  }
  const createdFor = (create: jest.Mock, at: string) =>
    (create.mock.calls as Array<[{ data: CreatedRow }]>)
      .map(([args]) => args.data)
      .find((data) => data.date.toISOString().slice(0, 10) === at);
  // Dates whose current plan was resolved, whether one by one (today) or in
  // the closed fallback batch (every batch starts with its probe).
  const planned = (current: jest.Mock, probe: jest.Mock) => [
    ...(
      current.mock.calls as Array<
        [{ where: { client_id_date: { date: Date } } }]
      >
    ).map(([args]) =>
      args.where.client_id_date.date.toISOString().slice(0, 10),
    ),
    ...(probe.mock.calls as Array<[{ where: { date: { in: Date[] } } }]>)
      .flatMap(([args]) => args.where.date.in)
      .map((at) => at.toISOString().slice(0, 10)),
  ];

  it('evaluates a proven closed day without an original row with the current plan', async () => {
    const { result, create } = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      date: day,
      basis: 'current_fallback',
      calendar: 'complete',
      revision: 1,
      evaluation: { global: { ratio: 1 } },
      schedule: { training: 'assigned', nutrition: 'assigned' },
      targets: { calories: 100, protein_g: 10 },
    });
    const row = createdFor(create, day);
    expect(row).toMatchObject({
      revision: 1,
      original_basis_id: null,
      cut_binding: null,
    });
    expect(row?.original_basis_digest).toMatch(
      /^current_fallback:v1:[0-9a-f]{64}$/,
    );
  });

  it('marks closed dates without an assignment as not assigned, not insufficient', async () => {
    const { result, current, probe, batch, raw } = await harness({
      plan: () => null,
    });
    expect(result.days[0]).toMatchObject({
      basis: 'current_fallback',
      calendar: 'not_assigned',
      schedule: { training: 'not_assigned', nutrition: 'not_assigned' },
    });
    // Every collected closed date resolves the current plan of that date, in
    // a single batched read rather than one read per date.
    expect(planned(current, probe).sort()).toEqual(window);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled();
    // No assignment at all: the relation and snapshot/history reads are
    // skipped.
    expect(batch).not.toHaveBeenCalled();
    expect(
      raw.mock.calls.some(([query]) => /day_snapshots/.test(sqlText(query))),
    ).toBe(false);
  });

  it('lets a published original prescription win over the current plan', async () => {
    const stored = {
      status: 'stored',
      digest: 'original-digest',
      manifest_digest: 'manifest',
      provenance: { epochId: 'epoch', origin: 'origin', cutoffUtc: 'cut' },
      prescription: {
        client_id: 'client',
        date: day,
        training: { rest: true, units: [] },
        nutrition: {
          basis: 'known',
          groups: [],
          total_calories: null,
          total_protein_g: null,
        },
      },
    };
    const { result, create, current, probe } = await harness({
      plan: () => assignment(),
      originals: new Map([[day, stored]]),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'original',
      calendar: 'rest',
    });
    expect(createdFor(create, day)).toMatchObject({
      original_basis_id: `client:${day}`,
      original_basis_digest: 'original-digest',
    });
    expect(planned(current, probe)).not.toContain(day);
  });

  it('keeps an unreadable original row unknown instead of replacing it', async () => {
    const { result, create } = await harness({
      plan: () => assignment(),
      originals: new Map([
        [day, { status: 'unknown', reason: 'invalid_stored_basis' }],
      ]),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'unknown',
      calendar: 'insufficient',
    });
    expect(createdFor(create, day)?.original_basis_digest).toBe(
      'missing_original',
    );
  });

  it('appends revision n+1 over a persisted missing_original evaluation', async () => {
    const { result, create } = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [progress],
      latest: 1,
    });
    expect(result.days[0]).toMatchObject({
      basis: 'current_fallback',
      revision: 2,
    });
    expect(createdFor(create, day)).toMatchObject({ revision: 2 });
  });

  it('follows the current plan: a changed plan yields a different revision key', async () => {
    const first = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [progress],
    });
    const second = await harness({
      plan: (at) =>
        at === day ? assignment('ALL', ['occurrence', 'added']) : null,
      dayProgress: [progress],
    });
    const before = createdFor(first.create, day);
    const after = createdFor(second.create, day);
    expect(after?.original_basis_digest).toMatch(/^current_fallback:v1:/);
    expect(after?.original_basis_digest).not.toBe(
      before?.original_basis_digest,
    );
    // The added occurrence is unproven, so the same evidence no longer
    // completes the training under the new plan.
    expect(first.result.days[0].evaluation.training.ratio).toBe(1);
    expect(second.result.days[0]).toMatchObject({
      basis: 'current_fallback',
      evaluation: { training: { ratio: null } },
    });
    // Unchanged plan content keeps the same digest (idempotent replay key).
    const replay = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [progress],
    });
    expect(createdFor(replay.create, day)?.original_basis_digest).toBe(
      before?.original_basis_digest,
    );
  });

  it('does not append a revision when only the catalog row order changes', async () => {
    const ingredient = (grams: number) => ({
      quantity: grams,
      unit: 'g',
      grams_equivalent: null,
      ingredient: { calories_per_100g: 100, protein_per_100g: 10 },
    });
    const reordered = (flip: boolean) => {
      const plan = assignment('ALL', flip ? ['b', 'a'] : ['a', 'b']);
      const roots = [
        {
          id: 'root',
          parent_meal_id: null,
          ingredients: flip
            ? [ingredient(30), ingredient(70)]
            : [ingredient(70), ingredient(30)],
          variants: flip
            ? [
                { id: 'alt-b', ingredients: [] },
                { id: 'alt', ingredients: [] },
              ]
            : [
                { id: 'alt', ingredients: [] },
                { id: 'alt-b', ingredients: [] },
              ],
        },
        { id: 'second', parent_meal_id: null, ingredients: [], variants: [] },
      ];
      return {
        ...plan,
        diet: { ...plan.diet, meals: flip ? [...roots].reverse() : roots },
      };
    };
    const runs: Awaited<ReturnType<typeof harness>>[] = [];
    for (const flip of [false, true])
      runs.push(
        await harness({
          plan: (at) => (at === day ? reordered(flip) : null),
          dayProgress: [{ ...progress, meals_completed: ['root'] }],
        }),
      );
    const [a, b] = runs.map((run) =>
      (
        run.create.mock.calls as Array<
          [{ data: CreatedRow & { evidence_digest: string } }]
        >
      )
        .map(([args]) => args.data)
        .find((data) => data.date.toISOString().slice(0, 10) === day),
    );
    expect(a?.original_basis_digest).toBe(b?.original_basis_digest);
    expect(a?.evidence_digest).toBe(b?.evidence_digest);
    expect(runs[1].result.days[0]).toEqual(runs[0].result.days[0]);
  });

  it('orders a fallback basis by UTF-16 code units, not by ICU collation', () => {
    const meal = (id: string) => ({ id, ingredients: [] });
    const ordered = canonicalFallbackBasis({
      ...basis,
      groups: ['b', 'B', 'a', 'Z'].map((id) => ({
        id,
        alternatives: ['é', 'e', 'E'].map(meal),
      })),
    });
    // localeCompare would give a, b, B, Z and e, E, é.
    expect(ordered.groups.map((group) => group.id)).toEqual([
      'B',
      'Z',
      'a',
      'b',
    ]);
    expect(ordered.groups[0].alternatives.map((alt) => alt.id)).toEqual([
      'E',
      'e',
      'é',
    ]);
  });

  it('counts fallback days in aggregates and the low-adherence verdict', async () => {
    const { result } = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [
        {
          ...progress,
          training_completed: false,
          trainings_completed: [],
          training_sessions: [],
          exercises_completed: [],
          meals_completed: [],
        },
      ],
    });
    expect(result.aggregate.global).toMatchObject({
      status: 'evaluable',
      ratio: 0,
    });
    expect(result.recentClosed).toMatchObject({
      status: 'low',
      coverage: {
        available: 7,
        evaluable: 1,
        not_applicable: 6,
        insufficient: 0,
      },
    });
  });

  it('keeps session-less legacy evidence indeterminate on fallback days', async () => {
    const { result } = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [
        {
          ...progress,
          training_sessions: [],
          exercises_completed: [],
          meals_completed: [],
        },
      ],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'current_fallback',
      evaluation: {
        training: { caveats: ['indeterminate_training'], ratio: null },
      },
    });
    expect(result.recentClosed.status).toBe('insufficient');
  });

  // ADH-FREEZE-01 U2: a closed day without a published original reads its
  // frozen adherence_day_bases row before falling back to the current plan.
  const frozenRow = (
    basis: Record<string, unknown> = {},
    row: Record<string, unknown> = {},
  ): { version: unknown; provenance: unknown; basis: unknown } => ({
    version: 1,
    provenance: 'scheduled',
    basis: {
      version: 1,
      assigned: true,
      assignment_id: 'assignment',
      rest: false,
      completion_mode: 'ALL',
      diet_id: 'diet',
      units: [
        { id: 'link', training_id: 'training', occurrences: ['occurrence'] },
      ],
      ...basis,
    },
    // Row-level overrides last, including a whole replacement basis.
    ...row,
  });
  const catalogDiet = () => ({ id: 'diet', ...assignment().diet });
  const frozenQueries = (raw: jest.Mock) =>
    (raw.mock.calls as Array<[unknown]>).filter(([query]) =>
      sqlText(query).includes('adherence_day_bases'),
    );
  const withoutSource = (value: Record<string, unknown>) => {
    const copy = { ...value };
    delete copy.basis;
    delete copy.revision;
    return copy;
  };

  it('reads the frozen row in one batch instead of the current plan', async () => {
    const { result, create, current, probe, raw } = await harness({
      plan: () => assignment('ALL', ['occurrence', 'edited-later']),
      frozen: new Map([[day, frozenRow()]]),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'original',
      calendar: 'complete',
      revision: 1,
      evaluation: { global: { ratio: 1 } },
      targets: { calories: 100, protein_g: 10 },
    });
    const row = createdFor(create, day);
    expect(row).toMatchObject({ original_basis_id: null, cut_binding: null });
    expect(row?.original_basis_digest).toMatch(/^frozen_day:v1:[0-9a-f]{64}$/);
    // The frozen date never resolves the (later edited) current plan.
    expect(planned(current, probe)).not.toContain(day);
    // One statement for every closed date without an original.
    const queries = frozenQueries(raw);
    expect(queries).toHaveLength(1);
    expect(sqlValues(queries[0][0])).toEqual(['client', ...window]);
  });

  it('keeps the frozen completion mode: ANY with one proven training is 1/1', async () => {
    const units = [
      { id: 'link', training_id: 'training', occurrences: ['occurrence'] },
      { id: 'link-2', training_id: 'other', occurrences: ['other-occurrence'] },
    ];
    const run = (mode: string) =>
      harness({
        plan: () => null,
        frozen: new Map([[day, frozenRow({ completion_mode: mode, units })]]),
        diets: [catalogDiet()],
        // Session-proven evidence only: no legacy day/training flags.
        dayProgress: [
          { ...progress, training_completed: false, trainings_completed: [] },
        ],
      });
    const any = await run('ANY');
    expect(any.result.days[0]).toMatchObject({
      basis: 'original',
      calendar: 'complete',
      evaluation: { training: { numerator: 1, denominator: 1 } },
    });
    const all = await run('ALL');
    expect(all.result.days[0]).toMatchObject({
      calendar: 'partial',
      evaluation: { training: { numerator: 1, denominator: 2 } },
    });
  });

  it('labels a late frozen row as an estimate (current_fallback) with the frozen key', async () => {
    const { result, create } = await harness({
      plan: () => null,
      frozen: new Map([[day, frozenRow({}, { provenance: 'late' })]]),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'current_fallback',
      calendar: 'complete',
    });
    expect(createdFor(create, day)?.original_basis_digest).toMatch(
      /^frozen_day:v1:/,
    );
  });

  it('freezes "not assigned" even if the current plan assigns the date later', async () => {
    const { result, current, probe } = await harness({
      plan: () => assignment(),
      frozen: new Map([
        [day, frozenRow({}, { basis: { version: 1, assigned: false } })],
      ]),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'original',
      calendar: 'not_assigned',
      schedule: { training: 'not_assigned', nutrition: 'not_assigned' },
    });
    expect(planned(current, probe)).not.toContain(day);
  });

  it.each([
    ['basis version', frozenRow({ version: 2 })],
    ['row version', frozenRow({}, { version: 2 })],
    ['provenance', frozenRow({}, { provenance: 'manual' })],
    ['rest', frozenRow({ rest: 'no' })],
    ['completion mode', frozenRow({ completion_mode: 'SOME' })],
    ['diet id', frozenRow({ diet_id: 7 })],
    [
      'unit id',
      frozenRow({ units: [{ training_id: 'training', occurrences: [] }] }),
    ],
    [
      'occurrence',
      frozenRow({
        units: [{ id: 'link', training_id: 'training', occurrences: [1] }],
      }),
    ],
    ['rest with units', frozenRow({ rest: true })],
    ['basis shape', frozenRow({}, { basis: 'not an object' })],
  ])(
    'keeps a frozen row with an invalid %s unknown without falling back',
    async (_field, row) => {
      const { result, create, current, probe } = await harness({
        plan: () => assignment(),
        frozen: new Map([[day, row]]),
        dayProgress: [progress],
      });
      expect(result.days[0]).toMatchObject({
        basis: 'unknown',
        calendar: 'insufficient',
        schedule: { training: 'unknown', nutrition: 'unknown' },
      });
      expect(createdFor(create, day)?.original_basis_digest).toBe(
        'missing_original',
      );
      expect(planned(current, probe)).not.toContain(day);
    },
  );

  it('lets a published original win over a frozen row, which is not even read', async () => {
    const stored = {
      status: 'stored',
      digest: 'original-digest',
      manifest_digest: 'manifest',
      provenance: { epochId: 'epoch', origin: 'origin', cutoffUtc: 'cut' },
      prescription: {
        client_id: 'client',
        date: day,
        training: { rest: true, units: [] },
        nutrition: {
          basis: 'known',
          groups: [],
          total_calories: null,
          total_protein_g: null,
        },
      },
    };
    const { result, create, raw } = await harness({
      plan: () => assignment(),
      originals: new Map([[day, stored]]),
      frozen: new Map([[day, frozenRow()]]),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'original',
      calendar: 'rest',
    });
    expect(createdFor(create, day)).toMatchObject({
      original_basis_id: `client:${day}`,
      original_basis_digest: 'original-digest',
    });
    expect(sqlValues(frozenQueries(raw)[0][0])).not.toContain(day);
  });

  it('gives a frozen row the same basis hash and evaluation as the fallback of the same plan', async () => {
    const fallback = await harness({
      plan: (at) => (at === day ? assignment() : null),
      dayProgress: [progress],
    });
    const frozen = await harness({
      plan: () => null,
      frozen: new Map([[day, frozenRow()]]),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    const before = createdFor(fallback.create, day)?.original_basis_digest;
    const after = createdFor(frozen.create, day)?.original_basis_digest;
    expect(before).toMatch(/^current_fallback:v1:[0-9a-f]{64}$/);
    expect(after).toMatch(/^frozen_day:v1:[0-9a-f]{64}$/);
    expect(after?.slice('frozen_day:v1:'.length)).toBe(
      before?.slice('current_fallback:v1:'.length),
    );
    expect(fallback.result.days[0].basis).toBe('current_fallback');
    expect(frozen.result.days[0].basis).toBe('original');
    expect(withoutSource({ ...frozen.result.days[0] })).toEqual(
      withoutSource({ ...fallback.result.days[0] }),
    );
  });

  it('resolves the frozen diet from its day snapshot before the catalog', async () => {
    const snapshot = {
      ...assignment().diet,
      total_calories: 500,
      total_protein_g: 50,
    };
    const { result, dietCatalog } = await harness({
      plan: () => null,
      frozen: new Map([[day, frozenRow()]]),
      diets: [catalogDiet()],
      dietHistory: [
        {
          client_id: 'client',
          date,
          diet_id: 'diet',
          version: 1,
          provenance: 'observed',
          captured_at: date,
          diet: snapshot,
        },
      ],
      dayProgress: [progress],
    });
    expect(result.days[0].targets).toEqual({ calories: 500, protein_g: 50 });
    expect(dietCatalog).not.toHaveBeenCalled();
  });

  it('fails closed when the frozen diet has neither a day snapshot nor a catalog row', async () => {
    const { result } = await harness({
      plan: () => null,
      frozen: new Map([[day, frozenRow({ diet_id: 'gone' })]]),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'original',
      schedule: { training: 'assigned', nutrition: 'unknown' },
      targets: { calories: null, protein_g: null },
      evaluation: {
        nutrition: {
          status: 'insufficient',
          caveats: ['unknown_nutrition_basis'],
        },
      },
    });
  });

  it('keeps a frozen null diet as a known day without nutrition', async () => {
    const { result, dietCatalog } = await harness({
      plan: () => null,
      frozen: new Map([[day, frozenRow({ diet_id: null })]]),
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      schedule: { training: 'assigned', nutrition: 'not_assigned' },
      targets: { calories: null, protein_g: null },
    });
    expect(dietCatalog).not.toHaveBeenCalled();
  });

  const storedOriginal = (at: string) => ({
    status: 'stored',
    digest: 'original-digest-' + at,
    manifest_digest: 'manifest',
    provenance: { epochId: 'epoch', origin: 'origin', cutoffUtc: 'cut' },
    prescription: {
      client_id: 'client',
      date: at,
      training: { rest: true, units: [] },
      nutrition: {
        basis: 'known',
        groups: [],
        total_calories: null,
        total_protein_g: null,
      },
    },
  });

  it('reads frozen rows only for closed dates: today and future dates are never queried', async () => {
    // The fixed clock is 2020-01-02T12:00Z: 2020-01-02 is today and
    // 2020-01-03 is in the future. Both have a frozen row available.
    const today = '2020-01-02';
    const future = '2020-01-03';
    const { result, raw } = await harness({
      plan: (at) => (at === today ? assignment() : null),
      frozen: new Map([
        ['2019-12-31', frozenRow()],
        [today, frozenRow({ diet_id: null })],
        [future, frozenRow({ diet_id: null })],
      ]),
      diets: [catalogDiet()],
      dayProgress: [progress],
      range: { start: '2019-12-31', end: future },
    });
    const queries = frozenQueries(raw);
    expect(queries).toHaveLength(1);
    // Client plus exactly the closed collected dates without an original.
    expect(sqlValues(queries[0][0])).toEqual(['client', ...window]);
    expect(sqlValues(queries[0][0])).not.toContain(today);
    expect(sqlValues(queries[0][0])).not.toContain(future);
    const byDate = new Map(result.days.map((d) => [d.date, d]));
    expect(byDate.get('2019-12-31')?.basis).toBe('original');
    expect(byDate.get(today)?.basis).toBe('current_provisional');
    expect(byDate.get(future)).toMatchObject({ calendar: 'future' });
    expect(byDate.get(future)?.basis).not.toBe('original');
  });

  it('keeps an unreadable original unknown even with a valid frozen row, which is not read', async () => {
    const { result, create, current, probe, raw } = await harness({
      plan: () => assignment(),
      originals: new Map([
        [day, { status: 'unknown', reason: 'invalid_stored_basis' }],
      ]),
      frozen: new Map([[day, frozenRow()]]),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    expect(result.days[0]).toMatchObject({
      basis: 'unknown',
      calendar: 'insufficient',
    });
    expect(createdFor(create, day)?.original_basis_digest).toBe(
      'missing_original',
    );
    expect(planned(current, probe)).not.toContain(day);
    // The other closed dates still go through the single frozen read.
    const queries = frozenQueries(raw);
    expect(queries).toHaveLength(1);
    expect(sqlValues(queries[0][0])).not.toContain(day);
    expect(sqlValues(queries[0][0])).toEqual([
      'client',
      ...window.filter((at) => at !== day),
    ]);
  });

  it('does not query adherence_day_bases when every closed date has a published original', async () => {
    const { result, create, raw } = await harness({
      plan: () => assignment(),
      originals: new Map(window.map((at) => [at, storedOriginal(at)])),
      frozen: new Map(window.map((at) => [at, frozenRow()])),
      diets: [catalogDiet()],
      dayProgress: [progress],
    });
    expect(frozenQueries(raw)).toHaveLength(0);
    expect(result.days[0].basis).toBe('original');
    expect(createdFor(create, day)?.original_basis_digest).toBe(
      'original-digest-' + day,
    );
  });

  it('resolves several frozen dates with distinct diets in one snapshot read and one catalog read', async () => {
    const dates = ['2019-12-29', '2019-12-30', '2019-12-31', day];
    const diet = (id: string, calories: number) => ({
      ...assignment().diet,
      id,
      total_calories: calories,
      total_protein_g: calories / 10,
    });
    const { result, raw, dietCatalog } = await harness({
      plan: () => null,
      frozen: new Map(
        dates.map((at, index) => [at, frozenRow({ diet_id: 'diet-' + index })]),
      ),
      diets: [diet('diet-1', 200), diet('diet-2', 300), diet('diet-3', 400)],
      dietHistory: [
        {
          client_id: 'client',
          date: new Date(dates[0] + 'T00:00:00Z'),
          diet_id: 'diet-0',
          version: 1,
          provenance: 'observed',
          captured_at: date,
          diet: diet('diet-0', 900),
        },
      ],
      dayProgress: [progress],
      range: { start: dates[0], end: day },
    });
    expect(result.days.map((d) => [d.date, d.basis, d.targets])).toEqual([
      [dates[0], 'original', { calories: 900, protein_g: 90 }],
      [dates[1], 'original', { calories: 200, protein_g: 20 }],
      [dates[2], 'original', { calories: 300, protein_g: 30 }],
      [dates[3], 'original', { calories: 400, protein_g: 40 }],
    ]);
    // No N+1: one diet_day_snapshots statement and one catalog read for
    // exactly the diets without a day snapshot.
    expect(
      (raw.mock.calls as Array<[unknown]>).filter(([query]) =>
        sqlText(query).includes('diet_day_snapshots'),
      ),
    ).toHaveLength(1);
    expect(dietCatalog).toHaveBeenCalledTimes(1);
    const [[catalogArgs]] = dietCatalog.mock.calls;
    expect([...catalogArgs.where.id.in].sort()).toEqual([
      'diet-1',
      'diet-2',
      'diet-3',
    ]);
  });

  it('resolves an inactive catalog diet of a frozen row like an active one and like the fallback', async () => {
    const run = (active: boolean) =>
      harness({
        plan: () => null,
        frozen: new Map([[day, frozenRow()]]),
        diets: [{ ...catalogDiet(), is_active: active }],
        dayProgress: [progress],
      });
    const active = await run(true);
    const inactive = await run(false);
    expect(inactive.result.days[0]).toMatchObject({
      basis: 'original',
      schedule: { training: 'assigned', nutrition: 'assigned' },
      targets: { calories: 100, protein_g: 10 },
    });
    expect(inactive.result.days[0]).toEqual(active.result.days[0]);
    const frozenDigest = createdFor(
      inactive.create,
      day,
    )?.original_basis_digest;
    expect(frozenDigest).toBe(
      createdFor(active.create, day)?.original_basis_digest,
    );
    // The fallback path reads the same inactive diet through the assignment.
    const fallback = await harness({
      plan: (at) =>
        at === day
          ? {
              ...assignment(),
              diet: { ...assignment().diet, is_active: false },
            }
          : null,
      dayProgress: [progress],
    });
    expect(withoutSource({ ...fallback.result.days[0] })).toEqual(
      withoutSource({ ...inactive.result.days[0] }),
    );
    expect(frozenDigest?.slice('frozen_day:v1:'.length)).toBe(
      createdFor(fallback.create, day)?.original_basis_digest.slice(
        'current_fallback:v1:'.length,
      ),
    );
  });

  // Owner decisions of 2026-11-18 (alternative a2): an informative training
  // activity overlaid on read, outside the persisted revision, and a neutral
  // "pending" calendar state for today at 0 %.
  describe('training activity overlay and pending calendar', () => {
    const today = '2020-01-02';
    const threeExercises = (at: string) =>
      at === day || at === today ? assignment('ALL', ['a', 'b', 'c']) : null;
    const sessionEntries = (occurrences: string[]) =>
      occurrences.map((occurrence) => ({
        training_session_id: 'session',
        training_exercise_id: occurrence,
        exercise_id: 'exercise',
        completed_at: '2020-01-01T12:00:00Z',
      }));
    const dayOf = (
      at: string,
      occurrences: string[],
      meals: string[] = [],
    ) => ({
      ...progress,
      date: new Date(at + 'T00:00:00Z'),
      training_completed: false,
      trainings_completed: [],
      training_sessions: occurrences.length
        ? [
            {
              training_session_id: 'session',
              training_id: 'training',
              rpe: null,
              note: null,
            },
          ]
        : [],
      exercises_completed: sessionEntries(occurrences),
      meals_completed: meals,
    });
    const keyFor = (findUnique: jest.Mock, at: string) =>
      (
        findUnique.mock.calls as Array<
          [
            {
              where: {
                client_id_date_idempotency_key: {
                  date: Date;
                  idempotency_key: string;
                };
              };
            },
          ]
        >
      )
        .map(([args]) => args.where.client_id_date_idempotency_key)
        .find((where) => where.date.toISOString().slice(0, 10) === at)
        ?.idempotency_key;
    const storedFor = (create: jest.Mock, at: string) =>
      (
        create.mock.calls as Array<
          [{ data: { date: Date; evaluation: Record<string, unknown> } }]
        >
      ).find(([args]) => args.data.date.toISOString().slice(0, 10) === at)?.[0]
        .data.evaluation;

    it('keeps a closed day with partial session exercises incomplete and adds n of m', async () => {
      const partial = await harness({
        plan: threeExercises,
        dayProgress: [dayOf(day, ['a', 'b'])],
      });
      const empty = await harness({
        plan: threeExercises,
        dayProgress: [dayOf(day, [])],
      });
      // Evaluation and calendar are exactly those of the empty day.
      expect(partial.result.days[0].calendar).toBe('incomplete');
      expect(empty.result.days[0].calendar).toBe('incomplete');
      expect(partial.result.days[0].evaluation).toEqual(
        empty.result.days[0].evaluation,
      );
      expect(partial.result.days[0].evaluation).toMatchObject({
        period: 'closed',
        training: { numerator: 0, denominator: 1, ratio: 0 },
        global: { ratio: 0 },
      });
      // Only the informative overlay tells them apart.
      expect(partial.result.days[0].training_activity).toEqual({
        recorded: true,
        unverified: false,
        units: [
          { unit_id: 'link', training_id: 'training', recorded: 2, total: 3 },
        ],
      });
      expect(empty.result.days[0].training_activity).toEqual({
        recorded: false,
        unverified: false,
        units: [
          { unit_id: 'link', training_id: 'training', recorded: 0, total: 3 },
        ],
      });
    });

    it('keeps the activity out of the revision key and the stored JSON', async () => {
      const partial = await harness({
        plan: threeExercises,
        dayProgress: [dayOf(day, ['a', 'b'])],
      });
      const empty = await harness({
        plan: threeExercises,
        dayProgress: [dayOf(day, [])],
      });
      const key = keyFor(partial.findUnique, day);
      // Value computed with the code of develop f997ea2, before the overlay:
      // the revision key of this evidence must not change byte for byte.
      expect(key).toBe(
        '4aa14c60b27b73009494bff183ed40d9f33155aa5815a88f44999402edf5b4bd',
      );
      // Same sync_revision and same normalized evidence: the partial activity
      // itself does not reach the key.
      expect(keyFor(empty.findUnique, day)).toBe(key);
      // A proven day (execution proofs in the evidence digest) keeps its key
      // too: the shared session helpers did not change the normalization.
      const proven = await harness({
        plan: (at) => (at === day ? assignment() : null),
        dayProgress: [progress],
      });
      expect(keyFor(proven.findUnique, day)).toBe(
        '58ae379361de53846ab740974ec5c79a99bb914a647b36b892c13c45f605d257',
      );
      const stored = storedFor(partial.create, day);
      expect(stored).toBeDefined();
      expect(stored).not.toHaveProperty('training_activity');
      const response: Record<string, unknown> = { ...partial.result.days[0] };
      delete response.training_activity;
      expect(stored).toEqual(JSON.parse(JSON.stringify(response)));
    });

    it('restores a stored revision without the field and still overlays the activity', async () => {
      const store = new Map<
        string,
        { evaluation: unknown; revision: number }
      >();
      const options = {
        plan: threeExercises,
        dayProgress: [dayOf(day, ['a', 'b'])],
        store,
      };
      const first = await harness(options);
      expect(createdFor(first.create, day)).toMatchObject({ revision: 1 });
      const second = await harness(options);
      // A second read appends nothing and restores the stored JSON.
      expect(second.create).not.toHaveBeenCalled();
      expect(second.result.days[0].revision).toBe(1);
      for (const stored of store.values())
        expect(stored.evaluation).not.toHaveProperty('training_activity');
      expect(second.result.days[0]).toEqual(first.result.days[0]);
      expect(second.result.days[0].training_activity).toMatchObject({
        recorded: true,
        units: [{ recorded: 2, total: 3 }],
      });
    });

    it('marks today at 0 % pending while closed days at 0 % stay incomplete', async () => {
      const { result, create } = await harness({
        plan: threeExercises,
        dayProgress: [dayOf(day, []), dayOf(today, ['a'])],
        range: { start: day, end: today },
      });
      const byDate = new Map(result.days.map((d) => [d.date, d]));
      expect(byDate.get(day)).toMatchObject({
        calendar: 'incomplete',
        evaluation: { period: 'closed', global: { ratio: 0 } },
      });
      expect(byDate.get(today)).toMatchObject({
        basis: 'current_provisional',
        calendar: 'pending',
        revision: null,
        evaluation: { period: 'provisional', global: { ratio: 0 } },
        training_activity: {
          recorded: true,
          units: [{ unit_id: 'link', recorded: 1, total: 3 }],
        },
      });
      // Provisional days never persist a revision, so "pending" is never
      // stored.
      expect(createdFor(create, today)).toBeUndefined();
      expect(
        (create.mock.calls as Array<[{ data: { date: Date } }]>).every(
          ([args]) => args.data.date.toISOString().slice(0, 10) < today,
        ),
      ).toBe(true);
    });

    it.each([
      ['partial', [] as string[], ['root'], 'partial'],
      ['complete', ['a', 'b', 'c'], ['root'], 'complete'],
    ])(
      'keeps today %s as before',
      async (_name, occurrences, meals, expected) => {
        const { result } = await harness({
          plan: threeExercises,
          dayProgress: [dayOf(today, occurrences, meals)],
          range: { start: today, end: today },
        });
        expect(result.days[0]).toMatchObject({
          calendar: expected,
          evaluation: { period: 'provisional' },
        });
      },
    );

    it('omits the activity on rest, unassigned and future days', async () => {
      const future = '2020-01-03';
      const { result } = await harness({
        plan: (at) =>
          at === day
            ? { ...assignment(), is_rest_day: true, diet_id: null, diet: null }
            : at === future
              ? assignment()
              : null,
        dayProgress: [dayOf(day, ['a'])],
        range: { start: day, end: future },
      });
      const byDate = new Map(result.days.map((d) => [d.date, d]));
      expect(byDate.get(day)).toMatchObject({
        calendar: 'rest',
        training_activity: null,
      });
      expect(byDate.get(today)).toMatchObject({
        calendar: 'not_assigned',
        training_activity: null,
      });
      expect(byDate.get(future)).toMatchObject({
        calendar: 'future',
        training_activity: null,
      });
    });

    it('keeps only the marks on a day whose plan is unknown', async () => {
      const { result } = await harness({
        plan: () => assignment(),
        originals: new Map([
          [day, { status: 'unknown', reason: 'invalid_stored_basis' }],
        ]),
        dayProgress: [dayOf(day, ['a'])],
      });
      expect(result.days[0]).toMatchObject({
        basis: 'unknown',
        calendar: 'insufficient',
        training_activity: { recorded: true, unverified: false, units: null },
      });
    });
  });
});
