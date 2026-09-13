# Timed prescriptions (FEAT-007)

`TrainingExercise` is the occurrence in a training, including members of circuits.
Its existing `measure_type: SECONDS` and integer `target_value` (or min/max range)
remain canonical. Do not use a `MINUTES` measure enum or store another total.

```json
{
  "measure_type": "SECONDS",
  "target_value": 1440,
  "timed_config": {
    "version": 1,
    "unit": "MINUTES",
    "segments": [
      { "action": "Corre", "seconds": 120, "unit": "MINUTES" },
      { "action": "Camina", "seconds": 60, "unit": "MINUTES" }
    ]
  }
}
```

The ordered sequence repeats within the total. The final segment is clipped at
the exact endpoint; instructions expose that truncation. Walking is part of the
total. `rest_seconds`, circuit rounds/rest and actual `sets[].seconds` are separate.
An empty segment list selects continuous duration and permits an existing range.
Intervals require an exact total. One to twenty nonempty actions (trimmed, max80)
are allowed; all durations must be positive integer seconds ≤2147483647.
Minute entry is converted before sending: 2→120, 1.5→90; fractional seconds are
rejected. Unit changes only change presentation. Nonterminating minute fractions
are rendered as minutes plus seconds rather than rounding the canonical value.

`timed_config` is optional and nullable on normal/circuit and legacy `exercises`
writes. Omission preserves an existing value; explicit null clears it. Changing
to REPS with intervals still present is rejected, never silently destructive.
Responses retain all existing fields and add `timed_config`/`timed_instructions`.
The latter is also prepended to the response's exercise `explanation_text` for
old mobile decoders. The catalogue explanation is never modified. Flat exercises,
items and blocks expose the same instruction. Old clients still see the numeric
total and can open the existing explanation UI. They do not acquire a new timer.

## Historical prescriptions

Migration `20260913120000_timed_prescriptions` adds immutable, owner/date/training
snapshots for trainings that contain temporal prescriptions. It captures the whole
mixed training so occurrence identity, circuit structure and performed-series
validation remain consistent after catalogue edits/removal. It reuses the existing
catalogue-before-client advisory lock order and protected-day definition. Past days
and days with persisted activity stay protected even after unmarking. Future days
without activity retain live templates. Snapshots contain the content available
when captured; `source=legacy_available` explicitly identifies the migration
backfill, which cannot reconstruct previously destroyed catalogue versions.

Converting an all-REPS training to time also captures its protected old content
before occurrence replacement deletes anything. Assignment reconciliation reads
snapshot identities in bulk and leaves their progress untouched.

Read paths `/trainings/day`, today, dated detail and progress assignment context
overlay snapshots before applying existing per-day RIR targets. Catalogue queries
and unstarted future assignments remain current. The owner FK cascades only for
the existing explicit client deletion workflow; snapshots also protect shared media
referenced by other clients from that cleanup. Snapshot UPDATE/DELETE is rejected
otherwise. No backfill modifies actual progress or attributes ambiguous ownership.

### Last-set evidence (ISSUE-070 review)

Migration `20260913130000_timed_feedback_history` replaces the occurrence's live
foreign key in feedback with an equivalent database check against the catalogue
or this owner's immutable dated prescription. The existing public
`training_exercise_id` stays canonical; no second identity is maintained. A
catalogue deletion retains that identity only for matching owned history; other
feedback keeps its previous SET NULL behavior. Owner, training, exercise and media
constraints remain. IDs already nulled before this migration cannot be inferred.

FeedbackService validates assigned training/date and uses history when available;
the write trigger revalidates under the catalogue/client lock order, including
equivalent SQL writers. First last-set video submission for a timed training
captures the prescription and marks the existing protected-day record. Later
catalogue edits cannot change its occurrence or orphan required video validation.
Existing upload consumption, transaction/outbox and owner/upload idempotency remain.

## App recovery

The existing owner/environment/session-bound Hive store gains optional adapter
fields8–11 (elapsed milliseconds, start timestamp, prescribed total/configuration).
New entries are scoped by occurrence/date; circuit timers also include round.
An owner-bound legacy active workout without a date remains in its original slot
until explicit completion, preserving its sets rather than guessing a migration
date. Unknown-owner entries keep the existing quarantine policy.

Elapsed time derives from accumulated milliseconds plus a timestamp, never tick
counts. Running time includes absence/process downtime; a paused timer does not.
Restoration reuses the captured total/configuration. Start, pause, reset, sets and
abandonment share a sequential event stream so durable writes cannot overtake one
another. Counter completion never invents a performance or writes API progress.
Existing offline operation identity, revision, owner and replay policy are unchanged.
Native rest notifications remain dedicated to rest; the execution timer is a
foreground display restored from the same local persistence infrastructure.

## Operations

No deployment is authorized by implementation. When separately authorized, apply
the additive migration and API before Admin/App; retain the columns/snapshots if
rolling back application code. Older APIs do not read frozen time history, so keep
catalogue writes paused during such a rollback. Also pause historical last-set
submissions with an older API. Retain the replacement integrity triggers; adding
the former FK back would reject preserved historical identities. See
`timed-prescriptions-recovery.sql`.
Validation, identified snapshots and limitations belong to the coordination root:
`docs/operations/timed-intervals-20260913/WORK.md`, not an independent editable tracker.
