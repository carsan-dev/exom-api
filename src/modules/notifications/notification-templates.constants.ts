export type NotificationTemplateKey =
  | 'plan_training_assigned'
  | 'plan_diet_assigned'
  | 'plan_updated'
  | 'training_reminder_daily'
  | 'diet_reminder_meal'
  | 'recap_reminder_weekly'
  | 'streak_at_risk'
  | 'achievement_unlocked'
  | 'challenge_assigned'
  | 'challenge_completed'
  | 'streak_milestone'
  | 'admin_client_assigned'
  | 'admin_feedback_submitted'
  | 'admin_weekly_summary';

export type NotificationTemplateDefinition = {
  key: NotificationTemplateKey;
  name: string;
  description: string;
  category: string;
  title: string;
  body: string;
  route: string;
  variables: string[];
};

export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplateDefinition[] = [
  {
    key: 'plan_training_assigned',
    name: 'Plan: entrenamiento asignado',
    description: 'Se envía cuando el admin asigna solo entrenamientos.',
    category: 'Plan',
    title: 'Nuevo entrenamiento asignado',
    body: 'Tu entrenador asignó {planSummary}',
    route: '/trainings',
    variables: ['planSummary', 'dayCount'],
  },
  {
    key: 'plan_diet_assigned',
    name: 'Plan: dieta asignada',
    description: 'Se envía cuando el admin asigna solo dietas.',
    category: 'Plan',
    title: 'Nueva dieta asignada',
    body: 'Tu entrenador asignó {planSummary}',
    route: '/diets',
    variables: ['planSummary', 'dayCount'],
  },
  {
    key: 'plan_updated',
    name: 'Plan actualizado',
    description: 'Se envía cuando la asignación mezcla entreno y dieta.',
    category: 'Plan',
    title: 'Tu plan se ha actualizado',
    body: 'Tu entrenador actualizó tu plan ({dayCount} días)',
    route: '/calendar',
    variables: ['dayCount'],
  },
  {
    key: 'training_reminder_daily',
    name: 'Recordatorio de entreno diario',
    description: 'Cron diario para entrenos pendientes.',
    category: 'Recordatorios',
    title: 'Tu entreno de hoy te espera',
    body: 'Abre la app y empieza cuando puedas.',
    route: '/trainings',
    variables: [],
  },
  {
    key: 'diet_reminder_meal',
    name: 'Recordatorio de comida',
    description: 'Cron para desayuno, comida, snack y cena pendientes.',
    category: 'Recordatorios',
    title: 'Hora de tu {mealLabel}',
    body: 'Revisa tu plan y registra la comida cuando termines.',
    route: '/diets',
    variables: ['mealLabel'],
  },
  {
    key: 'recap_reminder_weekly',
    name: 'Recordatorio recap semanal',
    description: 'Cron de domingo para recaps pendientes.',
    category: 'Recordatorios',
    title: 'Completa tu recap semanal',
    body: 'Cuéntanos cómo fue tu semana antes del domingo.',
    route: '/recap',
    variables: [],
  },
  {
    key: 'streak_at_risk',
    name: 'Racha en riesgo',
    description: 'Cron diario cuando un cliente aún no registró progreso.',
    category: 'Rachas',
    title: 'No pierdas tu racha de {days} días',
    body: 'Registra tu progreso de hoy para mantenerla activa.',
    route: '/',
    variables: ['days'],
  },
  {
    key: 'achievement_unlocked',
    name: 'Logro desbloqueado',
    description: 'Se envía cuando un cliente desbloquea un logro.',
    category: 'Gamificación',
    title: 'Logro desbloqueado',
    body: '{achievementName}',
    route: '/achievements',
    variables: ['achievementName'],
  },
  {
    key: 'challenge_assigned',
    name: 'Reto asignado',
    description: 'Se envía cuando un cliente recibe un reto.',
    category: 'Gamificación',
    title: 'Nuevo reto: {challengeName}',
    body: 'Tienes un nuevo reto disponible.',
    route: '/challenges',
    variables: ['challengeName'],
  },
  {
    key: 'challenge_completed',
    name: 'Reto completado',
    description: 'Se envía cuando un cliente completa un reto.',
    category: 'Gamificación',
    title: 'Reto completado: {challengeName}',
    body: 'Buen trabajo. Has completado el reto.',
    route: '/challenges',
    variables: ['challengeName'],
  },
  {
    key: 'streak_milestone',
    name: 'Milestone de racha',
    description: 'Se envía al llegar a 7, 30, 100 o 365 días.',
    category: 'Rachas',
    title: '{days} días de racha!',
    body: 'Sigue así. Tu constancia está creciendo.',
    route: '/',
    variables: ['days'],
  },
  {
    key: 'admin_client_assigned',
    name: 'Admin: cliente asignado',
    description: 'Se envía al admin cuando recibe un cliente.',
    category: 'Admin',
    title: 'Cliente asignado',
    body: '{clientName} te ha sido asignado',
    route: '/admin/clients/{clientId}',
    variables: ['clientName', 'clientId'],
  },
  {
    key: 'admin_feedback_submitted',
    name: 'Admin: feedback recibido',
    description: 'Se envía al admin cuando un cliente sube feedback.',
    category: 'Admin',
    title: 'Nuevo feedback de cliente',
    body: '{clientName} subió feedback',
    route: '/admin/feedback/{feedbackId}',
    variables: ['clientName', 'clientId', 'feedbackId'],
  },
  {
    key: 'admin_weekly_summary',
    name: 'Admin: resumen semanal',
    description: 'Cron de lunes con resumen por cliente asignado.',
    category: 'Admin',
    title: 'Resumen semanal de cliente',
    body: '{clientName}: {trainingsCompleted}/{trainingsAssigned} entrenos, {mealsCompleted}/{mealsAssigned} comidas',
    route: '/admin/clients/{clientId}',
    variables: [
      'clientName',
      'clientId',
      'trainingsCompleted',
      'trainingsAssigned',
      'mealsCompleted',
      'mealsAssigned',
    ],
  },
];

export const DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY = new Map(
  DEFAULT_NOTIFICATION_TEMPLATES.map((template) => [template.key, template]),
);
