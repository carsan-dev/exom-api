import { TrainingType } from '@prisma/client';

export const ACHIEVEMENT_CRITERIA_TYPES = [
  'TRAINING_DAYS',
  'STREAK_DAYS',
  'CHALLENGES_COMPLETED',
  'WEIGHT_LOGS',
  'CUSTOM',
] as const;

export type AchievementCriteriaType =
  (typeof ACHIEVEMENT_CRITERIA_TYPES)[number];

export interface AchievementRuleConfig {
  training_type?: TrainingType;
}
