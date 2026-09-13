import { Prisma } from '@prisma/client';
import { lockAssignmentPlanning } from './assignment-planning-lock';

/** Explicit, per-owner preparation for ADR-001. Never infer provenance or progress IDs.
 * Caller owns the transaction, target verification and authorization to apply.
 * At most 100 parents of each kind per call; rerun until both counts are zero.
 */
export async function backfillLegacyAssignmentLinks(
  tx: Prisma.TransactionClient,
  clientId: string,
) {
  await lockAssignmentPlanning(tx, clientId);
  const assignments = await tx.$executeRaw`
    INSERT INTO plan_assignment_trainings
      (id, assignment_id, training_id, position, last_set_video_policy, requires_last_set_video, legacy_video_exempt)
    SELECT gen_random_uuid()::text, a.id, a.training_id, 0, 'AUTO', false, true
    FROM plan_assignments a JOIN trainings t ON t.id = a.training_id
    WHERE a.client_id = ${clientId} AND NOT a.is_rest_day
      AND NOT EXISTS (SELECT 1 FROM plan_assignment_trainings l WHERE l.assignment_id = a.id)
    ORDER BY a.id LIMIT 100
    ON CONFLICT DO NOTHING`;
  const ruleDays = await tx.$executeRaw`
    INSERT INTO auto_assignment_rule_day_trainings
      (id, rule_day_id, training_id, position, last_set_video_policy, requires_last_set_video)
    SELECT gen_random_uuid()::text, d.id, d.training_id, 0, 'AUTO', false
    FROM auto_assignment_rule_days d
    JOIN auto_assignment_rules r ON r.id = d.rule_id
    JOIN trainings t ON t.id = d.training_id
    WHERE r.client_id = ${clientId} AND NOT d.is_rest_day
      AND NOT EXISTS (SELECT 1 FROM auto_assignment_rule_day_trainings l WHERE l.rule_day_id = d.id)
    ORDER BY d.id LIMIT 100
    ON CONFLICT DO NOTHING`;
  return { assignments, ruleDays };
}
