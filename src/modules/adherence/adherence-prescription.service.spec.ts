import { Prisma } from '@prisma/client';
import {
  AdherencePrescriptionService,
  type PrescriptionPublisher,
  type StoredPrescription,
} from './adherence-prescription.service';
import type { AdherenceCommitSql } from './adherence-commit-resolver';

const key = {
  epochId: 'original-epoch',
  origin: 'original-origin',
  cutoffUtc: '2020-01-02T00:00:00.000000Z',
};
const training = {
  id: 't',
  name: 'Original strength',
  type: 'STRENGTH',
  types: ['STRENGTH'],
  rir_proposal: [3, 2],
  estimated_duration_min: 40,
  warmup_description: 'Warm up',
  warmup_duration_min: 5,
  cooldown_description: null,
  created_by: 'private-owner',
  internal_notes: 'must not escape',
};
const exercise = {
  id: 'e',
  name: 'Original squat',
  video_url: 'https://private.invalid/signed',
  technique_text: 'private detail',
};
const occurrence = {
  id: 'o',
  training_id: 't',
  exercise_id: 'e',
  order: 0,
  block_id: null,
  position_in_block: null,
  sets: 3,
  reps_or_duration: '8-12',
  measure_type: 'REPS',
  target_value: null,
  target_value_min: 8,
  target_value_max: 12,
  target_rir: 3,
  request_set_tracking: true,
  rest_seconds: 90,
  timed_config: null,
  rir_override: { mode: 'FIXED', value: 2 },
};
const assignment = {
  id: 'a',
  client_id: 'c',
  date: '2020-01-01',
  training_id: 't',
  diet_id: null,
  is_rest_day: false,
  notes: 'private',
};
const link = {
  id: 'l',
  assignment_id: 'a',
  training_id: 't',
  position: 0,
  last_set_video_policy: 'AUTO',
  requires_last_set_video: true,
  legacy_video_exempt: false,
};
const baseline = (
  source_table: string,
  row_image: Record<string, unknown>,
) => ({ source_table, row_key: row_image.id, row_image });
function bundle() {
  return {
    state: 'source',
    manifest: {
      manifest_digest: 'a'.repeat(64),
      cutoff_microseconds: '1000',
      proofs: [{ proof: { full_xid: '9007199254740993', microseconds: '1' } }],
    },
    baseline: [
      baseline('trainings', training),
      baseline('exercises', exercise),
      baseline('training_exercises', occurrence),
      baseline('plan_assignments', assignment),
      baseline('plan_assignment_trainings', link),
    ],
    events: [] as Record<string, unknown>[],
  };
}
function event(
  sequence: string,
  xid: string,
  source_table: string,
  old_row: unknown,
  new_row: unknown,
) {
  return {
    event_sequence: sequence,
    transaction_id: xid,
    source_table,
    old_row,
    new_row,
    operation:
      old_row === null ? 'INSERT' : new_row === null ? 'DELETE' : 'UPDATE',
  };
}
class RawPromise<T> extends Promise<T> {
  get [Symbol.toStringTag]() {
    return 'PrismaPromise' as const;
  }
}
class Store implements AdherenceCommitSql, PrescriptionPublisher {
  source: unknown = bundle();
  payload?: unknown;
  trainingSnapshots: unknown[] = [];
  rirTargets: unknown[] = [];
  queries: string[] = [];
  args: unknown[][] = [];
  async withTransaction<T>(
    work: (sql: AdherenceCommitSql) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }
  $queryRaw<T = unknown>(
    query: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) {
    const statement = 'raw' in query ? Prisma.sql(query, ...values) : query;
    this.queries.push(statement.text);
    this.args.push(statement.values);
    return new RawPromise<T>((resolve, reject) => {
      let rows: unknown;
      if (statement.text.includes('adherence_prescription_source'))
        rows = [{ value: this.source }];
      else if (statement.text.includes('publish_adherence_prescription')) {
        const next = {
          prescription: JSON.parse(String(statement.values[5])) as unknown,
          provenance: key,
          manifest_digest: statement.values[6],
          digest: 'b'.repeat(64),
        };
        if (
          this.payload &&
          JSON.stringify(this.payload) !== JSON.stringify(next)
        ) {
          reject(new Error('discordant'));
          return;
        }
        this.payload = next;
        rows = [{ value: next }];
      } else if (statement.text.includes('training_day_snapshots')) {
        rows = this.trainingSnapshots;
      } else if (statement.text.includes('rir_day_targets')) {
        rows = this.rirTargets;
      } else rows = this.payload ? [{ value: this.payload }] : [];
      // Test SQL boundary, exactly like the production Prisma JSONB transport.
      resolve(rows as T);
    });
  }
}
async function publish(source = bundle()): Promise<StoredPrescription> {
  const db = new Store();
  db.source = source;
  const result = await new AdherencePrescriptionService(db, db).publish(
    'c',
    '2020-01-01',
    key,
  );
  expect(result.status).toBe('stored');
  if (result.status !== 'stored') throw new Error(JSON.stringify(result));
  expect(result.prescription.training.membership_basis).toBe('known');
  expect(result.prescription.training).not.toHaveProperty('basis');
  for (const unit of result.prescription.training.units) {
    expect(unit.effective_content.basis).toBe('unknown');
    expect(unit.effective_rir.basis).toBe('unknown');
    expect(unit.catalog_projection.authoritative).toBe(false);
    expect(unit).not.toHaveProperty('training');
  }
  return result;
}

const coveredSources = [
  'catalog_colors',
  'diet_groups',
  'diets',
  'exercises',
  'ingredients',
  'meal_ingredients',
  'meals',
  'plan_assignment_trainings',
  'plan_assignments',
  'training_blocks',
  'training_exercises',
  'training_groups',
  'trainings',
  'diet_day_snapshots',
  'rir_day_targets',
  'training_day_snapshots',
];
function coveredBundle() {
  const b = bundle();
  b.baseline[3] = baseline('plan_assignments', { ...assignment, diet_id: 'd' });
  b.baseline.push(
    baseline('diets', {
      id: 'd',
      name: 'Catalog',
      total_calories: 2200,
      total_protein_g: 120,
    }),
  );
  return b;
}
function cover(b: ReturnType<typeof bundle>) {
  const counts = Object.fromEntries(
    coveredSources.map((s) => [
      s,
      b.baseline.filter((r) => r.source_table === s).length,
    ]),
  );
  b.baseline.push(
    baseline('__adherence_coverage__', {
      id: 'effective-prescription-v2',
      version: 2,
      sources: coveredSources,
      counts,
    }),
  );
  return b;
}
const snapshotMeal = {
  id: 'm',
  diet_id: 'd',
  parent_meal_id: null,
  type: 'LUNCH',
  name: 'Lunch',
  order: 0,
  calories: 400,
  protein_g: 30,
  carbs_g: 40,
  fat_g: 10,
  ingredients: [
    {
      id: 'mi',
      meal_id: 'm',
      ingredient_id: 'i',
      quantity: 100,
      unit: 'g',
      grams_equivalent: null,
      ingredient: {
        id: 'i',
        name: 'Food',
        calories_per_100g: 400,
        protein_per_100g: 30,
        carbs_per_100g: 40,
        fat_per_100g: 10,
        created_by: 'private',
        icon: 'https://private',
      },
    },
  ],
  variants: [],
  image_url: 'https://private',
};
function overlay(source: string, row: Record<string, unknown>) {
  const tail =
    source === 'diet_day_snapshots'
      ? row.diet_id
      : source === 'training_day_snapshots'
        ? row.training_id
        : row.training_exercise_id;
  return {
    source_table: source,
    row_key: `[${[row.client_id, row.date, tail].map((v) => JSON.stringify(v)).join(', ')}]`,
    row_image: row,
  };
}
async function effective(b: ReturnType<typeof bundle>) {
  const db = new Store();
  db.source = b;
  return new AdherencePrescriptionService(db, db).publish(
    'c',
    '2020-01-01',
    key,
  );
}

describe('verified sixteen-source effective prescription', () => {
  it('distinguishes H1 snapshot diet/timing/day RIR from H2 catalog using all three inputs', async () => {
    const h1 = coveredBundle();
    h1.baseline.push(
      overlay('diet_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        diet_id: 'd',
        version: 1,
        provenance: 'legacy_available',
        captured_at: '1999-01-01',
        diet: {
          id: 'd',
          name: 'Snapshot',
          total_calories: 1800,
          total_protein_g: 90,
          meals: [snapshotMeal],
        },
      }),
      overlay('training_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        training_id: 't',
        version: 1,
        payload: {
          ...training,
          blocks: [],
          exercises: [
            {
              ...occurrence,
              target_value: 120,
              measure_type: 'SECONDS',
              reps_or_duration: '120 s',
              exercise,
              timed_config: {
                version: 1,
                unit: 'SECONDS',
                segments: [{ action: 'Run', seconds: 20, unit: 'SECONDS' }],
              },
            },
          ],
        },
      }),
      overlay('rir_day_targets', {
        client_id: 'c',
        date: '2020-01-01',
        training_id: 't',
        training_exercise_id: 'o',
        target_rir: 1,
      }),
    );
    const h2 = coveredBundle();
    h2.baseline.push(
      baseline('meals', {
        ...snapshotMeal,
        variants: undefined,
        ingredients: undefined,
      }),
    );
    const a = await effective(cover(h1));
    const c = await effective(cover(h2));
    expect(a).toMatchObject({
      status: 'stored',
      prescription: {
        nutrition: {
          basis: 'known',
          total_calories: 1800,
          total_protein_g: 90,
          groups: [
            {
              id: 'm',
              alternatives: [{ id: 'm', ingredients: [{ quantity: 100 }] }],
            },
          ],
        },
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_value: 120, target_rir: 1 }] },
              },
              effective_rir: { basis: 'known' },
            },
          ],
        },
      },
    });
    expect(c).toMatchObject({
      status: 'stored',
      prescription: {
        nutrition: {
          basis: 'known',
          total_calories: 2200,
          total_protein_g: 120,
        },
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_rir: 3 }] },
              },
            },
          ],
        },
      },
    });
    expect(a).not.toEqual(c);
    expect(JSON.stringify(a)).not.toMatch(
      /private|captured_at|legacy_available|image_url|icon/,
    );
  });
  it('missing exact overlay field is UNKNOWN, never catalog fallback or invented null', async () => {
    const b = coveredBundle();
    b.baseline.push(
      overlay('training_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        training_id: 't',
        version: 1,
        payload: { ...training, exercises: [], blocks: null },
      }),
    );
    expect(await effective(cover(b))).toMatchObject({ status: 'unknown' });
  });
  it('replays composite OLD-key moves in commit order with owner/date/occurrence isolation and explicit null', async () => {
    const b = coveredBundle();
    const old = {
      client_id: 'other',
      date: '2020-01-01',
      training_exercise_id: 'o',
      training_id: 't',
      target_rir: 1,
    };
    const moved = { ...old, client_id: 'c', target_rir: null };
    b.baseline.push(
      overlay('rir_day_targets', old),
      overlay('rir_day_targets', {
        ...old,
        client_id: 'c',
        date: '2020-01-02',
        target_rir: 2,
      }),
    );
    cover(b);
    b.manifest.proofs.push({
      proof: { full_xid: '9007199254740994', microseconds: '1000' },
    });
    b.events.push(
      event('2', '9007199254740994', 'rir_day_targets', old, moved),
    );
    expect(await effective(b)).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: { exercises: [{ target_rir: null }] },
              },
            },
          ],
        },
      },
    });
  });
  it.each(['total_calories', 'total_protein_g', 'meals'])(
    'incomplete snapshot %s does not fall back to complete catalog',
    async (field) => {
      const b = coveredBundle();
      const diet: Record<string, unknown> = {
        id: 'd',
        total_calories: 1800,
        total_protein_g: 90,
        meals: [snapshotMeal],
      };
      delete diet[field];
      b.baseline.push(
        overlay('diet_day_snapshots', {
          client_id: 'c',
          date: '2020-01-01',
          diet_id: 'd',
          diet,
        }),
      );
      expect(await effective(cover(b))).toMatchObject({ status: 'unknown' });
    },
  );
  it('retains every root and alternative, including ingredient-backed fractional nutrients', async () => {
    const b = coveredBundle();
    const variant = {
      ...snapshotMeal,
      id: 'alt',
      parent_meal_id: 'm',
      ingredients: [],
      variants: undefined,
    };
    const root = { ...snapshotMeal, protein_g: 30.5, variants: [variant] };
    b.baseline.push(
      overlay('diet_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        diet_id: 'd',
        diet: {
          id: 'd',
          total_calories: 1800,
          total_protein_g: 90.5,
          meals: [
            root,
            { ...snapshotMeal, id: 'second', order: 1, ingredients: [] },
          ],
        },
      }),
    );
    expect(await effective(cover(b))).toMatchObject({
      status: 'stored',
      prescription: {
        nutrition: {
          total_protein_g: 90.5,
          groups: [
            { id: 'm', alternatives: [{ protein_g: 30.5 }, { id: 'alt' }] },
            { id: 'second' },
          ],
        },
      },
    });
  });
  it('does not silently drop an incomplete snapshot block into a known empty training', async () => {
    const b = coveredBundle();
    const block = {
      id: 'block',
      order: 0,
      type: 'CIRCUIT',
      name: null,
      rounds: 3,
      rest_between_rounds_seconds: 60,
      exercises: [],
    };
    b.baseline.push(
      overlay('training_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        training_id: 't',
        version: 1,
        payload: { ...training, exercises: [], blocks: [block] },
      }),
    );
    expect(await effective(cover(b))).toMatchObject({ status: 'unknown' });
  });
  it('preserves valid snapshot flat and nested circuit occurrence formats together', async () => {
    const b = coveredBundle();
    const e = {
      ...occurrence,
      block_id: 'block',
      position_in_block: 0,
      exercise,
    };
    const block = {
      id: 'block',
      training_id: 't',
      order: 0,
      type: 'CIRCUIT',
      name: null,
      rounds: 3,
      rest_between_rounds_seconds: 60,
    };
    b.baseline.push(
      overlay('training_day_snapshots', {
        client_id: 'c',
        date: '2020-01-01',
        training_id: 't',
        version: 1,
        payload: {
          ...training,
          exercises: [{ ...e, block }],
          blocks: [{ ...block, exercises: [e] }],
        },
      }),
    );
    expect(await effective(cover(b))).toMatchObject({
      status: 'stored',
      prescription: {
        training: {
          units: [
            {
              effective_content: {
                basis: 'known',
                training: {
                  blocks: [{ id: 'block', rounds: 3 }],
                  exercises: [
                    { id: 'o', block_id: 'block', position_in_block: 0 },
                  ],
                },
              },
            },
          ],
        },
      },
    });
  });
  it('rejects a forged/incomplete coverage marker', async () => {
    const b = cover(coveredBundle());
    b.baseline.at(-1)!.row_image.counts = {};
    expect(await effective(b)).toMatchObject({ status: 'unknown' });
  });
});

describe('immutable historical prescription consumer', () => {
  it('publishes full untimed catalog projection and reads only the bounded stored membership basis', async () => {
    const db = new Store();
    const service = new AdherencePrescriptionService(db, db);
    const result = await service.publish('c', '2020-01-01', key);
    expect(result.status).toBe('stored');
    if (result.status !== 'stored') throw new Error('Expected stored');
    expect(result.prescription.training.units[0]).toStrictEqual({
      ...link,
      effective_content: {
        basis: 'unknown',
        reason: 'unproven_original_training_snapshot_and_rir_targets',
      },
      effective_rir: {
        basis: 'unknown',
        reason: 'unproven_original_rir_day_targets',
      },
      catalog_projection: {
        authoritative: false,
        id: 't',
        name: training.name,
        type: training.type,
        types: training.types,
        rir_proposal: [3, 2],
        estimated_duration_min: 40,
        warmup_description: 'Warm up',
        warmup_duration_min: 5,
        cooldown_description: null,
        blocks: [],
        exercises: [
          {
            ...Object.fromEntries(
              Object.entries(occurrence).filter(
                ([field]) => field !== 'training_id',
              ),
            ),
            name: exercise.name,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /signed|private|video_url|internal_notes|technique_text|created_by/,
    );
    db.queries = [];
    db.args = [];
    expect(await service.read('c', '2020-01-01')).toEqual(result);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]).not.toMatch(/journal|baseline|snapshot|profile/i);
    expect(db.args[0]).toEqual(['c', '2020-01-01']);
  });
  it('retains timed segments, block order and tracking without inventing weights', async () => {
    const b = bundle();
    b.baseline[2] = baseline('training_exercises', {
      ...occurrence,
      block_id: 'block',
      position_in_block: 1,
      measure_type: 'SECONDS',
      target_value: 60,
      target_value_min: null,
      target_value_max: null,
      reps_or_duration: '60 s',
      timed_config: {
        version: 1,
        unit: 'SECONDS',
        segments: [{ action: 'Work', seconds: 20, unit: 'SECONDS' }],
      },
    });
    b.baseline.push(
      baseline('training_blocks', {
        id: 'block',
        training_id: 't',
        order: 0,
        type: 'CIRCUIT',
        name: null,
        rounds: 3,
        rest_between_rounds_seconds: 60,
      }),
    );
    const unit = (await publish(b)).prescription.training.units[0];
    expect(unit.catalog_projection.blocks[0].rounds).toBe(3);
    expect(
      unit.catalog_projection.exercises[0].timed_config?.segments[0].seconds,
    ).toBe(20);
    expect(unit.catalog_projection.exercises[0]).not.toHaveProperty('weight');
  });
  it('preserves multiple ordered link/session identities, not the legacy mirror', async () => {
    const b = bundle();
    b.baseline.push(
      baseline('trainings', { ...training, id: 't2' }),
      baseline('plan_assignment_trainings', {
        ...link,
        id: 'l2',
        training_id: 't2',
        position: 1,
      }),
    );
    expect(
      (await publish(b)).prescription.training.units.map((u) => [
        u.id,
        u.position,
      ]),
    ).toEqual([
      ['l', 0],
      ['l2', 1],
    ]);
  });
  it('distinguishes proven rest, no assignment and unassigned nutrition', async () => {
    const b = bundle();
    b.baseline = [
      baseline('plan_assignments', {
        ...assignment,
        training_id: null,
        is_rest_day: true,
      }),
    ];
    expect((await publish(b)).prescription).toMatchObject({
      training: { rest: true, units: [] },
      nutrition: { basis: 'known', diet_id: null, groups: [] },
    });
    b.baseline = [];
    expect((await publish(b)).prescription).toMatchObject({
      assignment_id: null,
      training: { rest: false, units: [] },
    });
  });
  it('H1 prior V1 snapshot and H2 absent snapshot are indistinguishable: assigned diet UNKNOWN', async () => {
    const b = bundle();
    b.baseline[3] = baseline('plan_assignments', {
      ...assignment,
      diet_id: 'd',
    });
    b.baseline.push(
      baseline('diets', {
        id: 'd',
        name: 'V2',
        total_calories: 2200,
        total_protein_g: 120,
      }),
    );
    const h1 = new Store();
    const h2 = new Store();
    h1.source = b;
    h2.source = structuredClone(b);
    // Original evidence cannot bind either current snapshot state. Neither reader
    // may query it, and neither catalog V2 nor mutable Profile is a known diet.
    const s1 = new AdherencePrescriptionService(h1, h1);
    const s2 = new AdherencePrescriptionService(h2, h2);
    expect(await s1.publish('c', '2020-01-01', key)).toEqual(
      await s2.publish('c', '2020-01-01', key),
    );
    expect(await s1.read('c', '2020-01-01')).toMatchObject({
      prescription: {
        nutrition: {
          basis: 'unknown',
          reason: 'unproven_original_diet_snapshot_precedence',
          diet_id: 'd',
          groups: [],
        },
      },
    });
    expect(h1.queries.join(' ')).not.toMatch(
      /diet_day_snapshots|Profile|total_calories/,
    );
  });
  it('H1 training snapshot/RIR overlay and H2 absent overlays require UNKNOWN effective content', async () => {
    const b = bundle();
    const timed = {
      ...occurrence,
      measure_type: 'SECONDS',
      target_value: 60,
      target_value_min: null,
      target_value_max: null,
      reps_or_duration: '60 s',
    };
    b.baseline[2] = baseline('training_exercises', timed);
    const h1 = new Store();
    const h2 = new Store();
    h1.source = b;
    h2.source = structuredClone(b);
    // Identical original13 evidence; the actual historical reader could return
    // 120s/RIR1 in H1 and catalog60s/RIR3 in H2. Neither overlay is cut-bound.
    h1.trainingSnapshots = [
      {
        training_id: 't',
        payload: {
          ...training,
          exercises: [
            { ...timed, target_value: 120, reps_or_duration: '120 s' },
          ],
        },
      },
    ];
    h1.rirTargets = [{ training_exercise_id: 'o', target_rir: 1 }];
    const a = await new AdherencePrescriptionService(h1, h1).publish(
      'c',
      '2020-01-01',
      key,
    );
    const c = await new AdherencePrescriptionService(h2, h2).publish(
      'c',
      '2020-01-01',
      key,
    );
    expect(a).toEqual(c);
    expect(a).toMatchObject({
      prescription: {
        training: {
          membership_basis: 'known',
          rest: false,
          units: [
            {
              id: 'l',
              assignment_id: 'a',
              position: 0,
              effective_content: {
                basis: 'unknown',
                reason: 'unproven_original_training_snapshot_and_rir_targets',
              },
              effective_rir: {
                basis: 'unknown',
                reason: 'unproven_original_rir_day_targets',
              },
              catalog_projection: {
                authoritative: false,
                exercises: [{ target_value: 60, target_rir: 3 }],
              },
            },
          ],
        },
      },
    });
    expect(h1.queries.concat(h2.queries).join(' ')).not.toMatch(
      /training_day_snapshots|rir_day_targets|diet_day_snapshots|Profile/,
    );
  });
  it('orders committed transactions by exact microseconds, not XID or sequence', async () => {
    const b = bundle();
    const mid = { ...training, name: 'Mid' };
    const final = { ...training, name: 'Final' };
    b.manifest.proofs.push(
      { proof: { full_xid: '9007199254740995', microseconds: '100' } },
      { proof: { full_xid: '9007199254740994', microseconds: '200' } },
    );
    b.events = [
      event('2', '9007199254740994', 'trainings', mid, final),
      event('3', '9007199254740995', 'trainings', training, mid),
    ];
    expect(
      (await publish(b)).prescription.training.units[0].catalog_projection.name,
    ).toBe('Final');
  });
  it('preserves within-transaction event sequence, OLD key moves and cascades', async () => {
    const b = bundle();
    const moved = { ...link, id: 'moved' };
    b.manifest.proofs.push({
      proof: { full_xid: '9007199254740994', microseconds: '1000' },
    });
    b.events = [
      event('4', '9007199254740994', 'training_exercises', occurrence, null),
      event('3', '9007199254740994', 'plan_assignment_trainings', link, moved),
    ];
    const result = await publish(b);
    expect(result.prescription.training.units.map((u) => u.id)).toEqual([
      'moved',
    ]);
    expect(
      result.prescription.training.units[0].catalog_projection.exercises,
    ).toEqual([]);
  });
  it('includes exact cutoff commits and excludes later catalog/assignment edits', async () => {
    const b = bundle();
    b.manifest.proofs.push({
      proof: { full_xid: '9007199254740994', microseconds: '1001' },
    });
    b.events = [
      event('2', '9007199254740994', 'trainings', training, {
        ...training,
        name: 'Later',
      }),
      event('3', '9007199254740994', 'plan_assignments', assignment, {
        ...assignment,
        client_id: 'other',
      }),
    ];
    expect(
      (await publish(b)).prescription.training.units[0].catalog_projection.name,
    ).toBe(training.name);
  });
  it('uses a proven OLD/NEW causal chain for conflicting equal commit timestamps', async () => {
    const b = bundle();
    const mid = { ...training, name: 'Mid' };
    b.manifest.proofs.push(
      { proof: { full_xid: '9007199254740995', microseconds: '100' } },
      { proof: { full_xid: '9007199254740994', microseconds: '100' } },
    );
    b.events = [
      event('2', '9007199254740994', 'trainings', mid, {
        ...training,
        name: 'Final',
      }),
      event('3', '9007199254740995', 'trainings', training, mid),
    ];
    expect(
      (await publish(b)).prescription.training.units[0].catalog_projection.name,
    ).toBe('Final');
  });
  it('accepts independent commuting rows at equal commit timestamps', async () => {
    const b = bundle();
    b.manifest.proofs.push(
      { proof: { full_xid: '9007199254740995', microseconds: '100' } },
      { proof: { full_xid: '9007199254740994', microseconds: '100' } },
    );
    b.events = [
      event('2', '9007199254740994', 'trainings', training, {
        ...training,
        name: 'Updated',
      }),
      event('3', '9007199254740995', 'exercises', exercise, {
        ...exercise,
        name: 'Updated squat',
      }),
    ];
    const e = (await publish(b)).prescription.training.units[0]
      .catalog_projection;
    expect([e.name, e.exercises[0].name]).toEqual(['Updated', 'Updated squat']);
  });
  it('rejects conflicting ties instead of guessing XID order', async () => {
    const b = bundle();
    b.manifest.proofs.push(
      { proof: { full_xid: '9007199254740995', microseconds: '100' } },
      { proof: { full_xid: '9007199254740994', microseconds: '100' } },
    );
    b.events = [
      event('2', '9007199254740994', 'trainings', training, {
        ...training,
        name: 'A',
      }),
      event('3', '9007199254740995', 'trainings', training, {
        ...training,
        name: 'B',
      }),
    ];
    const db = new Store();
    db.source = b;
    expect(
      await new AdherencePrescriptionService(db, db).publish(
        'c',
        '2020-01-01',
        key,
      ),
    ).toEqual({ status: 'unknown', reason: 'ambiguous_commit_order' });
    expect(db.payload).toBeUndefined();
  });
  it.each(['sets', 'timed_config', 'target_rir', 'request_set_tracking'])(
    'missing essential %s never becomes empty known',
    async (field) => {
      const b = bundle();
      const row: Record<string, unknown> = { ...occurrence };
      delete row[field];
      b.baseline[2] = baseline('training_exercises', row);
      const db = new Store();
      db.source = b;
      expect(
        (
          await new AdherencePrescriptionService(db, db).publish(
            'c',
            '2020-01-01',
            key,
          )
        ).status,
      ).toBe('unknown');
      expect(db.payload).toBeUndefined();
    },
  );
  it('does not invent unproven link identity/video policy from a legacy mirror', async () => {
    const b = bundle();
    b.baseline = b.baseline.filter(
      (r) => r.source_table !== 'plan_assignment_trainings',
    );
    const db = new Store();
    db.source = b;
    expect(
      await new AdherencePrescriptionService(db, db).publish(
        'c',
        '2020-01-01',
        key,
      ),
    ).toEqual({ status: 'unknown', reason: 'unproven_training_unit_identity' });
    expect(db.payload).toBeUndefined();
  });
  it('missing assignment date never becomes a known unassigned day', async () => {
    const b = bundle();
    const row: Record<string, unknown> = { ...assignment };
    delete row.date;
    b.baseline[3] = baseline('plan_assignments', row);
    const db = new Store();
    db.source = b;
    expect(
      (
        await new AdherencePrescriptionService(db, db).publish(
          'c',
          '2020-01-01',
          key,
        )
      ).status,
    ).toBe('unknown');
    expect(db.payload).toBeUndefined();
  });
  it('invalid manifest digest is UNKNOWN, not a rejected or persisted basis', async () => {
    const b = bundle();
    b.manifest.manifest_digest = '';
    const db = new Store();
    db.source = b;
    expect(
      await new AdherencePrescriptionService(db, db).publish(
        'c',
        '2020-01-01',
        key,
      ),
    ).toEqual({ status: 'unknown', reason: 'unproven_original_cut' });
    expect(db.payload).toBeUndefined();
  });
  it('missing activation/commit proof never becomes known', async () => {
    const b = bundle();
    b.manifest.proofs = [];
    const db = new Store();
    db.source = b;
    expect(
      (
        await new AdherencePrescriptionService(db, db).publish(
          'c',
          '2020-01-01',
          key,
        )
      ).status,
    ).toBe('unknown');
    expect(db.payload).toBeUndefined();
  });
  it('pre-capture/invalid cut is explicit UNKNOWN and never persists', async () => {
    const db = new Store();
    db.source = { state: 'unknown' };
    expect(
      await new AdherencePrescriptionService(db, db).publish(
        'c',
        '2020-01-01',
        key,
      ),
    ).toEqual({ status: 'unknown', reason: 'unproven_original_cut' });
    expect(db.queries).toHaveLength(1);
  });
  it('rejects nonclosure bindings and invalid dates before privileged SQL', async () => {
    const db = new Store();
    const service = new AdherencePrescriptionService(db, db);
    expect((await service.publish('c', '2020-02-30', key)).status).toBe(
      'unknown',
    );
    expect(
      (
        await service.publish('c', '2020-01-01', {
          ...key,
          cutoffUtc: '2020-01-02T00:00:00.000001Z',
        })
      ).status,
    ).toBe('unknown');
    expect(db.queries).toHaveLength(0);
  });
  it('accepts exact replay, rejects discordance and propagates unacknowledged commit', async () => {
    const db = new Store();
    const service = new AdherencePrescriptionService(db, db);
    const result = await service.publish('c', '2020-01-01', key);
    expect(await service.publish('c', '2020-01-01', key)).toEqual(result);
    const b = bundle();
    b.baseline[0] = baseline('trainings', { ...training, name: 'Discordant' });
    db.source = b;
    await expect(service.publish('c', '2020-01-01', key)).rejects.toThrow(
      'discordant',
    );
    const noAck: PrescriptionPublisher = {
      async withTransaction(work) {
        await work(new Store());
        throw new Error('lost COMMIT acknowledgement');
      },
    };
    await expect(
      new AdherencePrescriptionService(db, noAck).publish(
        'c',
        '2020-01-01',
        key,
      ),
    ).rejects.toThrow('lost COMMIT');
  });
});
