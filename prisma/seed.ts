import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

// ⚠️  ANTES DE EJECUTAR EL SEED:
// 1. Crea los usuarios en Firebase Console → Authentication → Add user
// 2. Copia el UID de cada usuario y reemplaza los valores FIREBASE_UID_* a continuación
// 3. Asegúrate de que el .env tenga DATABASE_URL correcto y PostgreSQL esté corriendo
const FIREBASE_UID_SUPER_ADMIN = process.env.SEED_UID_SUPER_ADMIN || 'REPLACE_WITH_FIREBASE_UID_SUPER_ADMIN';
const FIREBASE_UID_ADMIN       = process.env.SEED_UID_ADMIN       || 'REPLACE_WITH_FIREBASE_UID_ADMIN';
const FIREBASE_UID_CLIENT      = process.env.SEED_UID_CLIENT      || 'REPLACE_WITH_FIREBASE_UID_CLIENT';

async function main() {
  console.log('🌱 Seeding database...');

  // ── Exercises ─────────────────────────────────────────────────────────────
  const exercises = await Promise.all([
    prisma.exercise.upsert({
      where: { id: 'ex-squat' },
      update: {},
      create: {
        id: 'ex-squat',
        name: 'Sentadilla',
        muscle_groups: ['Cuádriceps', 'Glúteos', 'Isquiotibiales'],
        equipment: ['Barra', 'Rack'],
        level: 'PRINCIPIANTE',
        technique_text: 'Pies a la anchura de los hombros, desciende hasta 90° manteniendo la espalda recta.',
        common_errors_text: 'Rodillas hacia adentro, talones levantados, espalda redondeada.',
        explanation_text: 'Ejercicio fundamental para el desarrollo de piernas y glúteos.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-bench' },
      update: {},
      create: {
        id: 'ex-bench',
        name: 'Press de Banca',
        muscle_groups: ['Pectoral', 'Tríceps', 'Deltoides anterior'],
        equipment: ['Barra', 'Banco'],
        level: 'PRINCIPIANTE',
        technique_text: 'Agarre ligeramente más ancho que los hombros, baja la barra hasta el pecho y empuja.',
        common_errors_text: 'Rebotar la barra en el pecho, arquear excesivamente la espalda.',
        explanation_text: 'El ejercicio más popular para desarrollo de pecho.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-deadlift' },
      update: {},
      create: {
        id: 'ex-deadlift',
        name: 'Peso Muerto',
        muscle_groups: ['Isquiotibiales', 'Glúteos', 'Espalda baja', 'Trapecios'],
        equipment: ['Barra'],
        level: 'INTERMEDIO',
        technique_text: 'Espalda neutra, barra cerca del cuerpo, empuja el suelo con los pies.',
        common_errors_text: 'Espalda redondeada, barra alejada del cuerpo, rodillas colapsadas.',
        explanation_text: 'El rey de los ejercicios compuestos, trabaja prácticamente todo el cuerpo.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-pullup' },
      update: {},
      create: {
        id: 'ex-pullup',
        name: 'Dominadas',
        muscle_groups: ['Dorsal', 'Bíceps', 'Romboides'],
        equipment: ['Barra de dominadas'],
        level: 'INTERMEDIO',
        technique_text: 'Agarre prono, sube hasta que la barbilla supere la barra.',
        common_errors_text: 'Balancearse, no completar el rango de movimiento.',
        explanation_text: 'Ejercicio esencial para el desarrollo de espalda.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-ohp' },
      update: {},
      create: {
        id: 'ex-ohp',
        name: 'Press Militar',
        muscle_groups: ['Deltoides', 'Tríceps', 'Trapecios'],
        equipment: ['Barra'],
        level: 'PRINCIPIANTE',
        technique_text: 'De pie, empuja la barra por encima de la cabeza extendiendo completamente los codos.',
        common_errors_text: 'Arquear la espalda lumbar, no extender completamente.',
        explanation_text: 'Ejercicio fundamental para el desarrollo de hombros.',
      },
    }),
  ]);

  console.log(`✅ ${exercises.length} exercises seeded`);

  // ── Ingredients ────────────────────────────────────────────────────────────
  const ingredients = await Promise.all([
    prisma.ingredient.upsert({
      where: { id: 'ing-chicken' },
      update: {},
      create: {
        id: 'ing-chicken',
        name: 'Pechuga de pollo',
        calories_per_100g: 165,
        protein_per_100g: 31,
        carbs_per_100g: 0,
        fat_per_100g: 3.6,
      },
    }),
    prisma.ingredient.upsert({
      where: { id: 'ing-rice' },
      update: {},
      create: {
        id: 'ing-rice',
        name: 'Arroz integral',
        calories_per_100g: 111,
        protein_per_100g: 2.6,
        carbs_per_100g: 23,
        fat_per_100g: 0.9,
      },
    }),
    prisma.ingredient.upsert({
      where: { id: 'ing-egg' },
      update: {},
      create: {
        id: 'ing-egg',
        name: 'Huevo entero',
        calories_per_100g: 155,
        protein_per_100g: 13,
        carbs_per_100g: 1.1,
        fat_per_100g: 11,
      },
    }),
    prisma.ingredient.upsert({
      where: { id: 'ing-oats' },
      update: {},
      create: {
        id: 'ing-oats',
        name: 'Avena',
        calories_per_100g: 389,
        protein_per_100g: 17,
        carbs_per_100g: 66,
        fat_per_100g: 7,
      },
    }),
    prisma.ingredient.upsert({
      where: { id: 'ing-broccoli' },
      update: {},
      create: {
        id: 'ing-broccoli',
        name: 'Brócoli',
        calories_per_100g: 34,
        protein_per_100g: 2.8,
        carbs_per_100g: 7,
        fat_per_100g: 0.4,
      },
    }),
  ]);

  console.log(`✅ ${ingredients.length} ingredients seeded`);

  // ── Sample Training ────────────────────────────────────────────────────────
  const training = await prisma.training.upsert({
    where: { id: 'tr-fullbody-a' },
    update: {},
    create: {
      id: 'tr-fullbody-a',
      name: 'Full Body A',
      type: 'FUERZA',
      level: 'PRINCIPIANTE',
      estimated_duration_min: 60,
      estimated_calories: 350,
      warmup_description: '5 min caminata en cinta + movilidad dinámica de caderas y hombros.',
      warmup_duration_min: 10,
      cooldown_description: 'Estiramientos estáticos de cuádriceps, isquiotibiales y pectorales.',
      tags: ['fuerza', 'fullbody', 'principiante'],
      exercises: {
        create: [
          { exercise_id: 'ex-squat', order: 1, sets: 4, reps_or_duration: '8-10', rest_seconds: 120 },
          { exercise_id: 'ex-bench', order: 2, sets: 4, reps_or_duration: '8-10', rest_seconds: 90 },
          { exercise_id: 'ex-deadlift', order: 3, sets: 3, reps_or_duration: '5', rest_seconds: 180 },
          { exercise_id: 'ex-ohp', order: 4, sets: 3, reps_or_duration: '8-10', rest_seconds: 90 },
          { exercise_id: 'ex-pullup', order: 5, sets: 3, reps_or_duration: 'Max', rest_seconds: 90 },
        ],
      },
    },
  });
  console.log(`✅ Training "${training.name}" seeded`);

  // ── Sample Diet ────────────────────────────────────────────────────────────
  const diet = await prisma.diet.upsert({
    where: { id: 'diet-performance-2500' },
    update: {},
    create: {
      id: 'diet-performance-2500',
      name: 'Plan Rendimiento 2500kcal',
      total_calories: 2500,
      total_protein_g: 190,
      total_carbs_g: 260,
      total_fat_g: 70,
      meals: {
        create: [
          {
            type: 'BREAKFAST',
            name: 'Desayuno energético',
            calories: 580,
            protein_g: 35,
            carbs_g: 70,
            fat_g: 15,
            order: 1,
            nutritional_badges: ['Alto en proteína', 'Energizante'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-oats', quantity: 100, unit: 'g' },
                { ingredient_id: 'ing-egg', quantity: 200, unit: 'g' },
              ],
            },
          },
          {
            type: 'LUNCH',
            name: 'Almuerzo de fuerza',
            calories: 750,
            protein_g: 60,
            carbs_g: 80,
            fat_g: 18,
            order: 2,
            nutritional_badges: ['Alto en proteína', 'Bajo en grasa'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-chicken', quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-rice', quantity: 150, unit: 'g' },
                { ingredient_id: 'ing-broccoli', quantity: 200, unit: 'g' },
              ],
            },
          },
          {
            type: 'SNACK',
            name: 'Snack proteico',
            calories: 320,
            protein_g: 30,
            carbs_g: 25,
            fat_g: 8,
            order: 3,
            nutritional_badges: [],
            ingredients: {
              create: [
                { ingredient_id: 'ing-egg', quantity: 150, unit: 'g' },
              ],
            },
          },
          {
            type: 'DINNER',
            name: 'Cena recuperación',
            calories: 650,
            protein_g: 55,
            carbs_g: 55,
            fat_g: 18,
            order: 4,
            nutritional_badges: ['Recuperación muscular'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-chicken', quantity: 180, unit: 'g' },
                { ingredient_id: 'ing-rice', quantity: 120, unit: 'g' },
                { ingredient_id: 'ing-broccoli', quantity: 150, unit: 'g' },
              ],
            },
          },
        ],
      },
    },
  });
  console.log(`✅ Diet "${diet.name}" seeded`);

  // ── Sample Achievements ────────────────────────────────────────────────────
  const achievements = await Promise.all([
    prisma.achievement.upsert({
      where: { id: 'ach-first-workout' },
      update: {},
      create: {
        id: 'ach-first-workout',
        name: 'Primer entrenamiento',
        description: 'Completaste tu primer entrenamiento',
        criteria_type: 'trainings_completed',
        criteria_value: 1,
      },
    }),
    prisma.achievement.upsert({
      where: { id: 'ach-week-streak' },
      update: {},
      create: {
        id: 'ach-week-streak',
        name: 'Racha semanal',
        description: 'Mantuviste una racha de 7 días',
        criteria_type: 'streak_days',
        criteria_value: 7,
      },
    }),
    prisma.achievement.upsert({
      where: { id: 'ach-month-streak' },
      update: {},
      create: {
        id: 'ach-month-streak',
        name: 'Mes de constancia',
        description: 'Mantuviste una racha de 30 días',
        criteria_type: 'streak_days',
        criteria_value: 30,
      },
    }),
    prisma.achievement.upsert({
      where: { id: 'ach-10-workouts' },
      update: {},
      create: {
        id: 'ach-10-workouts',
        name: 'En forma',
        description: 'Completaste 10 entrenamientos',
        criteria_type: 'trainings_completed',
        criteria_value: 10,
      },
    }),
  ]);
  console.log(`✅ ${achievements.length} achievements seeded`);

  // ── Users ─────────────────────────────────────────────────────────────────
  const superAdmin = await prisma.user.upsert({
    where: { firebase_uid: FIREBASE_UID_SUPER_ADMIN },
    update: {},
    create: {
      id: 'user-super-admin',
      email: 'superadmin@exom.dev',
      firebase_uid: FIREBASE_UID_SUPER_ADMIN,
      role: 'SUPER_ADMIN',
      auth_provider: 'email',
      profile: {
        create: {
          first_name: 'Super',
          last_name: 'Admin',
        },
      },
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { firebase_uid: FIREBASE_UID_ADMIN },
    update: {},
    create: {
      id: 'user-admin',
      email: 'admin@exom.dev',
      firebase_uid: FIREBASE_UID_ADMIN,
      role: 'ADMIN',
      auth_provider: 'email',
      profile: {
        create: {
          first_name: 'Carlos',
          last_name: 'Entrenador',
        },
      },
    },
  });

  const clientUser = await prisma.user.upsert({
    where: { firebase_uid: FIREBASE_UID_CLIENT },
    update: {},
    create: {
      id: 'user-client',
      email: 'cliente@exom.dev',
      firebase_uid: FIREBASE_UID_CLIENT,
      role: 'CLIENT',
      auth_provider: 'email',
      profile: {
        create: {
          first_name: 'María',
          last_name: 'Cliente',
          current_weight: 68.5,
          height: 165,
          main_goal: 'Perder grasa y ganar músculo',
          level: 'PRINCIPIANTE',
          target_calories: 2000,
        },
      },
    },
  });

  console.log(`✅ Users seeded: ${superAdmin.email}, ${adminUser.email}, ${clientUser.email}`);

  // ── Admin-Client Assignment ────────────────────────────────────────────────
  await prisma.adminClientAssignment.upsert({
    where: {
      admin_id_client_id: {
        admin_id: adminUser.id,
        client_id: clientUser.id,
      },
    },
    update: {},
    create: {
      admin_id: adminUser.id,
      client_id: clientUser.id,
    },
  });

  console.log(`✅ AdminClientAssignment: ${adminUser.email} → ${clientUser.email}`);

  // ── Plan Assignments (today + next 6 days) ─────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);

    await prisma.planAssignment.upsert({
      where: {
        client_id_date: {
          client_id: clientUser.id,
          date,
        },
      },
      update: {},
      create: {
        client_id: clientUser.id,
        admin_id: adminUser.id,
        date,
        training_id: i % 2 === 0 ? training.id : null,
        diet_id: diet.id,
      },
    });
  }

  console.log(`✅ PlanAssignments: 7 days assigned for ${clientUser.email}`);

  // ── Initial Streak for client ──────────────────────────────────────────────
  await prisma.streak.upsert({
    where: { client_id: clientUser.id },
    update: {},
    create: {
      client_id: clientUser.id,
      current_days: 0,
      longest_days: 0,
    },
  });

  console.log('🎉 Seed completed successfully!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
