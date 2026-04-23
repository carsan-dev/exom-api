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

export type NotificationTemplateDeliveryInfo = {
  type: 'event' | 'schedule' | 'manual';
  label: string;
  description: string;
  timezone?: string;
  cron?: string;
  times?: string[];
  weekday?: number | null;
  schedule_enabled?: boolean;
  schedule_kind?: NotificationTemplateScheduleKind;
};

export type NotificationTemplateScheduleKind = 'daily' | 'weekly' | 'meal_daily';

export type NotificationTemplateScheduleDefinition = {
  templateKey: NotificationTemplateKey;
  kind: NotificationTemplateScheduleKind;
  defaultTimezone: string;
  defaultTimes: string[];
  defaultWeekday?: number | null;
};

export const NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE = 'Europe/Madrid';

export const NOTIFICATION_TEMPLATE_SCHEDULES: NotificationTemplateScheduleDefinition[] = [
  {
    templateKey: 'training_reminder_daily',
    kind: 'daily',
    defaultTimezone: NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
    defaultTimes: ['09:00'],
  },
  {
    templateKey: 'diet_reminder_meal',
    kind: 'meal_daily',
    defaultTimezone: NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
    defaultTimes: ['08:00', '13:00', '17:00', '20:30'],
  },
  {
    templateKey: 'recap_reminder_weekly',
    kind: 'weekly',
    defaultTimezone: NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
    defaultTimes: ['19:00'],
    defaultWeekday: 0,
  },
  {
    templateKey: 'streak_at_risk',
    kind: 'daily',
    defaultTimezone: NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
    defaultTimes: ['20:00'],
  },
  {
    templateKey: 'admin_weekly_summary',
    kind: 'weekly',
    defaultTimezone: NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
    defaultTimes: ['09:00'],
    defaultWeekday: 1,
  },
];

export const NOTIFICATION_TEMPLATE_SCHEDULE_BY_KEY = new Map(
  NOTIFICATION_TEMPLATE_SCHEDULES.map((schedule) => [
    schedule.templateKey,
    schedule,
  ]),
);

export const NOTIFICATION_TEMPLATE_VARIABLE_HELP: Record<string, string> = {
  achievementName: 'Nombre del logro desbloqueado.',
  challengeName: 'Nombre del reto asignado o completado.',
  clientId: 'Identificador interno del cliente para construir enlaces.',
  clientName: 'Nombre visible del cliente.',
  dayCount: 'Número de días incluidos en el plan o hito.',
  days: 'Número de días de racha.',
  feedbackId: 'Identificador interno del feedback para abrir su detalle.',
  mealLabel: 'Nombre de la comida: desayuno, comida, snack o cena.',
  mealsAssigned: 'Total de comidas planificadas en la semana.',
  mealsCompleted: 'Comidas registradas por el cliente en la semana.',
  planSummary: 'Resumen del plan asignado, por ejemplo "un entrenamiento" o "2 días de dieta".',
  trainingsAssigned: 'Total de entrenamientos planificados en la semana.',
  trainingsCompleted: 'Entrenamientos completados por el cliente en la semana.',
};

export const NOTIFICATION_TEMPLATE_DELIVERY_INFO: Record<
  NotificationTemplateKey,
  NotificationTemplateDeliveryInfo
> = {
  plan_training_assigned: {
    type: 'event',
    label: 'Al asignar entrenamientos',
    description:
      'Se envía al cliente justo después de asignar entrenamientos desde planificación.',
  },
  plan_diet_assigned: {
    type: 'event',
    label: 'Al asignar dietas',
    description:
      'Se envía al cliente justo después de asignar dietas desde planificación.',
  },
  plan_updated: {
    type: 'event',
    label: 'Al actualizar plan mixto',
    description:
      'Se envía al cliente cuando una asignación mezcla entreno y dieta.',
  },
  training_reminder_daily: {
    type: 'schedule',
    label: 'Todos los días a las 09:00',
    description:
      'Recuerda entrenamientos pendientes del día a clientes activos.',
    timezone: 'Europe/Madrid',
    cron: '0 9 * * *',
    times: ['09:00'],
  },
  diet_reminder_meal: {
    type: 'schedule',
    label: 'Todos los días a las 08:00, 13:00, 17:00 y 20:30',
    description:
      'Recuerda comidas pendientes. El sistema rellena la variable de comida según la hora.',
    timezone: 'Europe/Madrid',
    cron: '0 8 * * *, 0 13 * * *, 0 17 * * *, 30 20 * * *',
    times: ['08:00', '13:00', '17:00', '20:30'],
  },
  recap_reminder_weekly: {
    type: 'schedule',
    label: 'Domingos a las 19:00',
    description:
      'Recuerda completar el recap semanal a clientes activos sin recap enviado.',
    timezone: 'Europe/Madrid',
    cron: '0 19 * * 0',
    times: ['19:00'],
  },
  streak_at_risk: {
    type: 'schedule',
    label: 'Todos los días a las 20:00',
    description:
      'Avisa a clientes activos con racha que todavía no registraron progreso hoy.',
    timezone: 'Europe/Madrid',
    cron: '0 20 * * *',
    times: ['20:00'],
  },
  achievement_unlocked: {
    type: 'event',
    label: 'Al desbloquear un logro',
    description:
      'Se envía al cliente justo después de conceder o detectar un logro.',
  },
  challenge_assigned: {
    type: 'event',
    label: 'Al asignar un reto',
    description:
      'Se envía al cliente cuando recibe un reto nuevo.',
  },
  challenge_completed: {
    type: 'event',
    label: 'Al completar un reto',
    description:
      'Se envía al cliente cuando el reto pasa a completado.',
  },
  streak_milestone: {
    type: 'event',
    label: 'Al alcanzar un hito de racha',
    description:
      'Se envía al llegar a 7, 30, 100 o 365 días de racha.',
  },
  admin_client_assigned: {
    type: 'event',
    label: 'Al asignar cliente a admin',
    description:
      'Se envía al admin cuando recibe un cliente asignado.',
  },
  admin_feedback_submitted: {
    type: 'event',
    label: 'Al subir feedback',
    description:
      'Se envía al admin cuando un cliente sube un feedback nuevo.',
  },
  admin_weekly_summary: {
    type: 'schedule',
    label: 'Lunes a las 09:00',
    description:
      'Envía al admin el resumen de la semana anterior por cliente asignado.',
    timezone: 'Europe/Madrid',
    cron: '0 9 * * 1',
    times: ['09:00'],
  },
};

export const DEFAULT_NOTIFICATION_TEMPLATES: NotificationTemplateDefinition[] = [
  {
    key: 'plan_training_assigned',
    name: 'Plan: entrenamiento asignado',
    description: 'Se envía cuando el admin asigna solo entrenamientos.',
    category: 'Plan',
    title: 'Nuevo entrenamiento asignado',
    body: 'Tu entrenador asignó {planSummary}',
    route: '/trainings?date={date}',
    variables: ['planSummary', 'dayCount', 'date'],
  },
  {
    key: 'plan_diet_assigned',
    name: 'Plan: dieta asignada',
    description: 'Se envía cuando el admin asigna solo dietas.',
    category: 'Plan',
    title: 'Nueva dieta asignada',
    body: 'Tu entrenador asignó {planSummary}',
    route: '/diets?date={date}',
    variables: ['planSummary', 'dayCount', 'date'],
  },
  {
    key: 'plan_updated',
    name: 'Plan actualizado',
    description: 'Se envía cuando la asignación mezcla entreno y dieta.',
    category: 'Plan',
    title: 'Tu plan se ha actualizado',
    body: 'Tu entrenador actualizó tu plan ({dayCount} días)',
    route: '/calendar?date={date}',
    variables: ['dayCount', 'date'],
  },
  {
    key: 'training_reminder_daily',
    name: 'Recordatorio de entreno diario',
    description: 'Cron diario para entrenos pendientes.',
    category: 'Recordatorios',
    title: 'Tu entreno de hoy te espera',
    body: 'Abre la app y empieza cuando puedas.',
    route: '/trainings?date={date}',
    variables: ['date'],
  },
  {
    key: 'diet_reminder_meal',
    name: 'Recordatorio de comida',
    description: 'Cron para desayuno, comida, snack y cena pendientes.',
    category: 'Recordatorios',
    title: 'Hora de tu {mealLabel}',
    body: 'Revisa tu plan y registra la comida cuando termines.',
    route: '/diets?date={date}',
    variables: ['mealLabel', 'date'],
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
