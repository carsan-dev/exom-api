import { COMPLETION } from '../../common/progress/daily-adherence-evaluator';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { AdherencePrescriptionService } from './adherence-prescription.service';
import {
  AdherenceEvaluationService,
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
        .spyOn(AdherencePrescriptionService.prototype, 'read')
        .mockResolvedValue({ status: 'unknown', reason: 'missing_original' });
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
        weeklyRecap: { findFirst: jest.fn().mockResolvedValue(null) },
        dayProgress: { findUnique: jest.fn().mockResolvedValue(null) },
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
            read.mock.calls.filter(([, date]) => date < start).length,
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
            ([owner, date]) => owner === 'client' && date < '2020-01-02',
          ),
        ).toBe(true);
        expect(current).toHaveBeenCalledTimes(start === '2020-01-02' ? 1 : 0);
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
