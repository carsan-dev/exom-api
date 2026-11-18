import type { Pool } from 'pg';

// ADH-FREEZE-01 U5: migration 20261118120000 disables (does not drop) the 16
// row capture triggers that feed adherence_assignment_journal and
// adherence_catalog_journal. Journals are written only while they are enabled.
// [table, trigger, capture function]: 20261001010000 L50-55,
// 20261001030000 L99-107, 20261002050000 L75-89.
export const ADHERENCE_JOURNAL_TRIGGERS: ReadonlyArray<
  readonly [string, string, string]
> = [
  [
    'plan_assignments',
    'adherence_assignment_event',
    'capture_adherence_assignment_event()',
  ],
  [
    'plan_assignment_trainings',
    'adherence_assignment_training_event',
    'capture_adherence_assignment_event()',
  ],
  ...[
    'trainings',
    'training_blocks',
    'training_exercises',
    'exercises',
    'training_groups',
    'diet_groups',
    'catalog_colors',
    'diets',
    'meals',
    'meal_ingredients',
    'ingredients',
  ].map(
    (table) =>
      [
        table,
        'adherence_catalog_event',
        'capture_adherence_catalog_event()',
      ] as const,
  ),
  ...['diet_day_snapshots', 'rir_day_targets', 'training_day_snapshots'].map(
    (table) =>
      [
        table,
        'adherence_effective_event',
        'capture_adherence_effective_event()',
      ] as const,
  ),
];

// pg_trigger.tgenabled -> the ALTER TABLE clause that sets it back.
const RESTORE: Record<string, string> = {
  O: 'ENABLE',
  D: 'DISABLE',
  R: 'ENABLE REPLICA',
  A: 'ENABLE ALWAYS',
};

async function states(pool: Pool): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ key: string; enabled: string | null }>(
    `SELECT e.tbl || '.' || e.trg AS key, t.tgenabled::text AS enabled
     FROM unnest($1::text[], $2::text[], $3::text[]) AS e(tbl, trg, fn)
     LEFT JOIN pg_trigger t ON t.tgrelid = to_regclass('public.' || e.tbl)
       AND t.tgname = e.trg AND t.tgfoid = to_regprocedure('public.' || e.fn)
       AND NOT t.tgisinternal`,
    [
      ADHERENCE_JOURNAL_TRIGGERS.map(([table]) => table),
      ADHERENCE_JOURNAL_TRIGGERS.map(([, trigger]) => trigger),
      ADHERENCE_JOURNAL_TRIGGERS.map(([, , fn]) => fn),
    ],
  );
  const missing = rows.filter((row) => !row.enabled).map((row) => row.key);
  if (rows.length !== ADHERENCE_JOURNAL_TRIGGERS.length || missing.length)
    throw new Error(
      `Missing adherence journal triggers: ${missing.join(', ')}`,
    );
  return new Map(rows.map((row) => [row.key, row.enabled ?? '']));
}

async function alterAll(
  pool: Pool,
  clause: (table: string, trigger: string) => string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A transaction left open by a test must fail this fast and loudly, well
    // inside Jest's hook timeout, instead of blocking the restore.
    await client.query("SET LOCAL lock_timeout = '2s'");
    for (const [table, trigger] of ADHERENCE_JOURNAL_TRIGGERS)
      await client.query(
        `ALTER TABLE public.${table} ${clause(table, trigger)} TRIGGER ${trigger}`,
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Test setup only, for suites that exercise the dormant journal / history-cut
// machinery: enables the 16 triggers in the suite's own disposable database
// (after migrations). The returned function puts every trigger back in the
// state it had before, so suites sharing that database keep the migrated
// (disabled) state.
export async function enableAdherenceJournalTriggers(
  pool: Pool,
): Promise<() => Promise<void>> {
  const previous = await states(pool);
  const restore = () =>
    alterAll(
      pool,
      (table, trigger) => RESTORE[previous.get(`${table}.${trigger}`) ?? ''],
    );
  await alterAll(pool, () => 'ENABLE');
  try {
    const enabled = await states(pool);
    if ([...enabled.values()].some((state) => state !== 'O'))
      throw new Error('Adherence journal triggers were not enabled');
  } catch (error) {
    // No restore function reaches the caller on this path: undo here.
    await restore().catch((restoreError: unknown) => {
      throw new AggregateError(
        [error, restoreError],
        'Adherence journal triggers may be left enabled',
      );
    });
    throw error;
  }
  return restore;
}
