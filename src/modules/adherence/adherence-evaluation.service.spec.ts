import {
  COMPLETION,
  evaluateDailyAdherence,
} from '../../common/progress/daily-adherence-evaluator';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AdherencePrescriptionService } from './adherence-prescription.service';
import {
  AdherenceEvaluationService,
  canonicalFallbackBasis,
  normalizeAdherenceEvidence,
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
  async function harness(options: {
    plan: (at: string) => Assignment;
    originals?: Map<string, unknown>;
    dayProgress?: unknown[];
    latest?: number | null;
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
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: jest.fn((query: unknown) =>
        Promise.resolve(
          sqlText(query).includes('adherence_config_revisions')
            ? AdherencePeriodQueryDto.dates('2019-12-23', '2020-01-05').map(
                policy,
              )
            : [],
        ),
      ),
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
        findUnique: jest.fn().mockResolvedValue(null),
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
        .get('client', 'CLIENT', 'client', { start: day, end: day });
      return { result, create, current, probe, batch, raw: tx.$queryRaw };
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
});
