export type ApprovalCheckType =
  | 'ownership'
  | 'always'
  | 'meal_diet_ownership'
  | 'challenge_global'
  | 'challenge_ownership'
  | 'challenge_client_ownership'
  | 'target_client_ownership'
  | 'notification_recipient_ownership';

export interface ApprovalRule {
  check: ApprovalCheckType;
}

export const APPROVAL_RULES: Record<string, ApprovalRule> = {
  'training.update': { check: 'ownership' },
  'training.delete': { check: 'always' },
  'diet.update': { check: 'ownership' },
  'diet.delete': { check: 'always' },
  'exercise.update': { check: 'ownership' },
  'exercise.delete': { check: 'always' },
  'ingredient.update': { check: 'ownership' },
  'ingredient.delete': { check: 'always' },
  'meal.create': { check: 'meal_diet_ownership' },
  'meal.update': { check: 'meal_diet_ownership' },
  'meal.delete': { check: 'meal_diet_ownership' },
  'challenge.create': { check: 'challenge_global' },
  'challenge.update': { check: 'challenge_ownership' },
  'challenge.delete': { check: 'always' },
  'challenge.assign': { check: 'challenge_client_ownership' },
  'achievement.create': { check: 'always' },
  'achievement.update': { check: 'always' },
  'achievement.grant': { check: 'target_client_ownership' },
  'achievement.revoke': { check: 'always' },
  'achievement.recompute': { check: 'always' },
  'notification.send': { check: 'notification_recipient_ownership' },
};

export const APPROVAL_ACTION_LABELS: Record<string, string> = {
  'training.update': 'modificar entrenamiento',
  'training.delete': 'eliminar entrenamiento',
  'diet.update': 'modificar dieta',
  'diet.delete': 'eliminar dieta',
  'exercise.update': 'modificar ejercicio',
  'exercise.delete': 'eliminar ejercicio',
  'ingredient.update': 'modificar ingrediente',
  'ingredient.delete': 'eliminar ingrediente',
  'meal.create': 'crear comida',
  'meal.update': 'modificar comida',
  'meal.delete': 'eliminar comida',
  'challenge.create': 'crear reto',
  'challenge.update': 'modificar reto',
  'challenge.delete': 'eliminar reto',
  'challenge.assign': 'asignar reto',
  'achievement.create': 'crear logro',
  'achievement.update': 'modificar logro',
  'achievement.grant': 'otorgar logro',
  'achievement.revoke': 'revocar logro',
  'achievement.recompute': 'recalcular logros',
  'notification.send': 'enviar notificación',
};
