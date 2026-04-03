export const CHALLENGE_RULE_KEYS = [
  'TRAINING_DAYS',
  'MEAL_CHECKINS',
  'WEIGHT_LOGS',
  'STREAK_DAYS',
] as const;

export type ChallengeRuleKey = (typeof CHALLENGE_RULE_KEYS)[number];
