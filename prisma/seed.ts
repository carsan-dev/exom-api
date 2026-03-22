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
const FIREBASE_UID_SUPER_ADMIN = process.env.SEED_UID_SUPER_ADMIN  || 'REPLACE_WITH_FIREBASE_UID_SUPER_ADMIN';
const FIREBASE_UID_ADMIN       = process.env.SEED_UID_ADMIN        || 'REPLACE_WITH_FIREBASE_UID_ADMIN';
const FIREBASE_UID_CLIENT      = process.env.SEED_UID_CLIENT       || 'REPLACE_WITH_FIREBASE_UID_CLIENT';
const FIREBASE_UID_CLIENT_2    = process.env.SEED_UID_CLIENT_2     || 'REPLACE_WITH_FIREBASE_UID_CLIENT_2';

async function main() {
  console.log('🌱 Seeding database...');

  // ── Exercises ─────────────────────────────────────────────────────────────
  await Promise.all([
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
    // Nuevos ejercicios
    prisma.exercise.upsert({
      where: { id: 'ex-pushup' },
      update: {},
      create: {
        id: 'ex-pushup',
        name: 'Flexiones',
        muscle_groups: ['Pectoral', 'Tríceps', 'Deltoides anterior'],
        equipment: [],
        level: 'PRINCIPIANTE',
        technique_text: 'Cuerpo recto como tabla, baja el pecho hasta casi tocar el suelo y empuja.',
        common_errors_text: 'Cadera hundida o elevada, codos muy abiertos.',
        explanation_text: 'Ejercicio de empuje fundamental sin equipamiento.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-lunge' },
      update: {},
      create: {
        id: 'ex-lunge',
        name: 'Zancadas',
        muscle_groups: ['Cuádriceps', 'Glúteos', 'Isquiotibiales'],
        equipment: [],
        level: 'PRINCIPIANTE',
        technique_text: 'Da un paso adelante y baja la rodilla trasera hasta casi tocar el suelo.',
        common_errors_text: 'Rodilla delantera pasando el pie, torso inclinado hacia adelante.',
        explanation_text: 'Ejercicio unilateral excelente para equilibrio y fuerza de piernas.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-row' },
      update: {},
      create: {
        id: 'ex-row',
        name: 'Remo con Mancuerna',
        muscle_groups: ['Dorsal', 'Romboides', 'Bíceps', 'Trapecios'],
        equipment: ['Mancuerna', 'Banco'],
        level: 'PRINCIPIANTE',
        technique_text: 'Apóyate en el banco, tira la mancuerna hacia la cadera manteniendo el codo cerca del cuerpo.',
        common_errors_text: 'Girar el torso, usar impulso en vez de músculo.',
        explanation_text: 'Ejercicio unilateral para desarrollo completo de espalda.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-curl' },
      update: {},
      create: {
        id: 'ex-curl',
        name: 'Curl de Bíceps',
        muscle_groups: ['Bíceps', 'Braquial'],
        equipment: ['Mancuernas'],
        level: 'PRINCIPIANTE',
        technique_text: 'Codos fijos a los costados, curl hasta 90° y baja controlado.',
        common_errors_text: 'Balancear el cuerpo, codos moviéndose hacia adelante.',
        explanation_text: 'Aislamiento clásico para el desarrollo de bíceps.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-tricep-ext' },
      update: {},
      create: {
        id: 'ex-tricep-ext',
        name: 'Extensión de Tríceps',
        muscle_groups: ['Tríceps'],
        equipment: ['Mancuerna'],
        level: 'PRINCIPIANTE',
        technique_text: 'Sobre la cabeza, baja la mancuerna detrás de la nuca y extiende los codos.',
        common_errors_text: 'Codos que se abren, no controlar la bajada.',
        explanation_text: 'Aislamiento efectivo para la cabeza larga del tríceps.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-lateral-raise' },
      update: {},
      create: {
        id: 'ex-lateral-raise',
        name: 'Elevaciones Laterales',
        muscle_groups: ['Deltoides lateral'],
        equipment: ['Mancuernas'],
        level: 'PRINCIPIANTE',
        technique_text: 'Brazos ligeramente flexionados, eleva hasta la altura de los hombros.',
        common_errors_text: 'Usar impulso, elevar por encima de los hombros.',
        explanation_text: 'Indispensable para dar anchura visual a los hombros.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-burpee' },
      update: {},
      create: {
        id: 'ex-burpee',
        name: 'Burpees',
        muscle_groups: ['Full Body', 'Cardio'],
        equipment: [],
        level: 'INTERMEDIO',
        technique_text: 'Desde posición de pie: baja, flexión, salta hacia atrás, flexión, salta hacia adelante y salta con brazos arriba.',
        common_errors_text: 'Saltarse la flexión, no extender el cuerpo en el salto.',
        explanation_text: 'Ejercicio de alta intensidad que trabaja todo el cuerpo y dispara el metabolismo.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-mountain-climber' },
      update: {},
      create: {
        id: 'ex-mountain-climber',
        name: 'Mountain Climbers',
        muscle_groups: ['Core', 'Cardio', 'Hombros'],
        equipment: [],
        level: 'PRINCIPIANTE',
        technique_text: 'Posición de plancha, lleva las rodillas hacia el pecho alternando rápidamente.',
        common_errors_text: 'Cadera elevada, ritmo demasiado lento.',
        explanation_text: 'Cardio y core en un único ejercicio dinámico.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-plank' },
      update: {},
      create: {
        id: 'ex-plank',
        name: 'Plancha Isométrica',
        muscle_groups: ['Core', 'Abdominales', 'Lumbar'],
        equipment: [],
        level: 'PRINCIPIANTE',
        technique_text: 'Antebrazos en el suelo, cuerpo recto. Aguanta la posición.',
        common_errors_text: 'Cadera caída o muy elevada, contener la respiración.',
        explanation_text: 'El ejercicio más eficiente para fortalecer el core.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-leg-press' },
      update: {},
      create: {
        id: 'ex-leg-press',
        name: 'Prensa de Piernas',
        muscle_groups: ['Cuádriceps', 'Glúteos', 'Isquiotibiales'],
        equipment: ['Máquina leg press'],
        level: 'PRINCIPIANTE',
        technique_text: 'Pies a la anchura de caderas, baja controlado y empuja sin bloquear rodillas.',
        common_errors_text: 'Bajar demasiado quitando espalda del respaldo, bloquear las rodillas.',
        explanation_text: 'Alternativa a la sentadilla con barra para principiantes o rehabilitación.',
      },
    }),
    prisma.exercise.upsert({
      where: { id: 'ex-calf-raise' },
      update: {},
      create: {
        id: 'ex-calf-raise',
        name: 'Elevaciones de Talones',
        muscle_groups: ['Gemelos', 'Sóleo'],
        equipment: [],
        level: 'PRINCIPIANTE',
        technique_text: 'De pie, sube de puntillas lo más alto posible y baja lentamente.',
        common_errors_text: 'Movimiento demasiado rápido, no bajar por debajo del nivel del suelo.',
        explanation_text: 'Aislamiento efectivo para el desarrollo de la pantorrilla.',
      },
    }),
  ]);

  console.log('✅ Exercises seeded');

  // ── Ingredients ────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.ingredient.upsert({ where: { id: 'ing-chicken' }, update: {}, create: { id: 'ing-chicken', name: 'Pechuga de pollo', calories_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-rice' }, update: {}, create: { id: 'ing-rice', name: 'Arroz integral', calories_per_100g: 111, protein_per_100g: 2.6, carbs_per_100g: 23, fat_per_100g: 0.9 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-egg' }, update: {}, create: { id: 'ing-egg', name: 'Huevo entero', calories_per_100g: 155, protein_per_100g: 13, carbs_per_100g: 1.1, fat_per_100g: 11 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-oats' }, update: {}, create: { id: 'ing-oats', name: 'Avena', calories_per_100g: 389, protein_per_100g: 17, carbs_per_100g: 66, fat_per_100g: 7 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-broccoli' }, update: {}, create: { id: 'ing-broccoli', name: 'Brócoli', calories_per_100g: 34, protein_per_100g: 2.8, carbs_per_100g: 7, fat_per_100g: 0.4 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-salmon' }, update: {}, create: { id: 'ing-salmon', name: 'Salmón', calories_per_100g: 208, protein_per_100g: 20, carbs_per_100g: 0, fat_per_100g: 13 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-sweet-potato' }, update: {}, create: { id: 'ing-sweet-potato', name: 'Boniato', calories_per_100g: 86, protein_per_100g: 1.6, carbs_per_100g: 20, fat_per_100g: 0.1 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-banana' }, update: {}, create: { id: 'ing-banana', name: 'Plátano', calories_per_100g: 89, protein_per_100g: 1.1, carbs_per_100g: 23, fat_per_100g: 0.3 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-tuna' }, update: {}, create: { id: 'ing-tuna', name: 'Atún en lata', calories_per_100g: 116, protein_per_100g: 26, carbs_per_100g: 0, fat_per_100g: 1 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-yogurt' }, update: {}, create: { id: 'ing-yogurt', name: 'Yogur griego', calories_per_100g: 97, protein_per_100g: 9, carbs_per_100g: 4, fat_per_100g: 5 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-pasta' }, update: {}, create: { id: 'ing-pasta', name: 'Pasta integral', calories_per_100g: 131, protein_per_100g: 5, carbs_per_100g: 25, fat_per_100g: 1.1 } }),
    prisma.ingredient.upsert({ where: { id: 'ing-spinach' }, update: {}, create: { id: 'ing-spinach', name: 'Espinacas', calories_per_100g: 23, protein_per_100g: 2.9, carbs_per_100g: 3.6, fat_per_100g: 0.4 } }),
  ]);

  console.log('✅ Ingredients seeded');

  // ── Trainings ─────────────────────────────────────────────────────────────

  // Full Body A (existing)
  await prisma.training.upsert({
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
          { exercise_id: 'ex-squat',    order: 1, sets: 4, reps_or_duration: '8-10', rest_seconds: 120 },
          { exercise_id: 'ex-bench',    order: 2, sets: 4, reps_or_duration: '8-10', rest_seconds: 90  },
          { exercise_id: 'ex-deadlift', order: 3, sets: 3, reps_or_duration: '5',    rest_seconds: 180 },
          { exercise_id: 'ex-ohp',      order: 4, sets: 3, reps_or_duration: '8-10', rest_seconds: 90  },
          { exercise_id: 'ex-pullup',   order: 5, sets: 3, reps_or_duration: 'Max',  rest_seconds: 90  },
        ],
      },
    },
  });

  // Push — Pecho, Hombros y Tríceps
  await prisma.training.upsert({
    where: { id: 'tr-push-a' },
    update: {},
    create: {
      id: 'tr-push-a',
      name: 'Push A — Pecho, Hombros y Tríceps',
      type: 'FUERZA',
      level: 'PRINCIPIANTE',
      estimated_duration_min: 55,
      estimated_calories: 320,
      warmup_description: 'Rotaciones de hombros, círculos de brazos y 2 series ligeras de flexiones.',
      warmup_duration_min: 8,
      cooldown_description: 'Estiramiento de pectoral en la pared, estiramiento de tríceps sobre la cabeza.',
      tags: ['fuerza', 'push', 'pecho', 'hombros'],
      exercises: {
        create: [
          { exercise_id: 'ex-bench',       order: 1, sets: 4, reps_or_duration: '8-12', rest_seconds: 90  },
          { exercise_id: 'ex-pushup',      order: 2, sets: 3, reps_or_duration: '15-20', rest_seconds: 60 },
          { exercise_id: 'ex-ohp',         order: 3, sets: 4, reps_or_duration: '8-10',  rest_seconds: 90 },
          { exercise_id: 'ex-lateral-raise', order: 4, sets: 3, reps_or_duration: '12-15', rest_seconds: 60 },
          { exercise_id: 'ex-tricep-ext',  order: 5, sets: 3, reps_or_duration: '12-15', rest_seconds: 60 },
        ],
      },
    },
  });

  // Pull — Espalda y Bíceps
  await prisma.training.upsert({
    where: { id: 'tr-pull-a' },
    update: {},
    create: {
      id: 'tr-pull-a',
      name: 'Pull A — Espalda y Bíceps',
      type: 'FUERZA',
      level: 'PRINCIPIANTE',
      estimated_duration_min: 55,
      estimated_calories: 310,
      warmup_description: 'Rotaciones de hombros, dislocaciones con goma y jalones suaves al pecho.',
      warmup_duration_min: 8,
      cooldown_description: 'Estiramiento de dorsal en máquina, estiramiento de bíceps en pared.',
      tags: ['fuerza', 'pull', 'espalda', 'bíceps'],
      exercises: {
        create: [
          { exercise_id: 'ex-deadlift', order: 1, sets: 4, reps_or_duration: '5-6',   rest_seconds: 180 },
          { exercise_id: 'ex-pullup',   order: 2, sets: 4, reps_or_duration: 'Max',   rest_seconds: 120 },
          { exercise_id: 'ex-row',      order: 3, sets: 4, reps_or_duration: '10-12', rest_seconds: 90  },
          { exercise_id: 'ex-curl',     order: 4, sets: 3, reps_or_duration: '12-15', rest_seconds: 60  },
        ],
      },
    },
  });

  // Legs — Piernas
  await prisma.training.upsert({
    where: { id: 'tr-legs-a' },
    update: {},
    create: {
      id: 'tr-legs-a',
      name: 'Legs A — Piernas y Glúteos',
      type: 'FUERZA',
      level: 'PRINCIPIANTE',
      estimated_duration_min: 60,
      estimated_calories: 380,
      warmup_description: 'Movilidad de cadera, sentadillas de peso corporal y elevaciones de pierna lateral.',
      warmup_duration_min: 10,
      cooldown_description: 'Estiramiento de cuádriceps, isquiotibiales y piriforme.',
      tags: ['fuerza', 'piernas', 'glúteos'],
      exercises: {
        create: [
          { exercise_id: 'ex-squat',      order: 1, sets: 4, reps_or_duration: '8-10',  rest_seconds: 120 },
          { exercise_id: 'ex-leg-press',  order: 2, sets: 3, reps_or_duration: '12-15', rest_seconds: 90  },
          { exercise_id: 'ex-lunge',      order: 3, sets: 3, reps_or_duration: '10 c/l', rest_seconds: 60 },
          { exercise_id: 'ex-deadlift',   order: 4, sets: 3, reps_or_duration: '8',      rest_seconds: 120 },
          { exercise_id: 'ex-calf-raise', order: 5, sets: 4, reps_or_duration: '20',     rest_seconds: 45  },
        ],
      },
    },
  });

  // HIIT Cardio
  await prisma.training.upsert({
    where: { id: 'tr-hiit-a' },
    update: {},
    create: {
      id: 'tr-hiit-a',
      name: 'HIIT Cardio — 20 min',
      type: 'HIIT',
      level: 'INTERMEDIO',
      estimated_duration_min: 25,
      estimated_calories: 280,
      warmup_description: '3 min trote suave + saltos de tijera suaves.',
      warmup_duration_min: 5,
      cooldown_description: '3 min caminata + estiramientos de isquiotibiales y caderas.',
      tags: ['hiit', 'cardio', 'quema grasa', 'sin equipamiento'],
      exercises: {
        create: [
          { exercise_id: 'ex-burpee',          order: 1, sets: 4, reps_or_duration: '45s', rest_seconds: 15 },
          { exercise_id: 'ex-mountain-climber', order: 2, sets: 4, reps_or_duration: '45s', rest_seconds: 15 },
          { exercise_id: 'ex-pushup',          order: 3, sets: 4, reps_or_duration: '45s', rest_seconds: 15 },
          { exercise_id: 'ex-squat',           order: 4, sets: 4, reps_or_duration: '45s', rest_seconds: 15 },
          { exercise_id: 'ex-plank',           order: 5, sets: 3, reps_or_duration: '60s', rest_seconds: 30 },
        ],
      },
    },
  });

  console.log('✅ Trainings seeded');

  // ── Diets ─────────────────────────────────────────────────────────────────

  // Plan Rendimiento 2500kcal (existing)
  await prisma.diet.upsert({
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
                { ingredient_id: 'ing-egg',  quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-banana', quantity: 100, unit: 'g' },
              ],
            },
          },
          {
            type: 'SNACK',
            name: 'Snack pre-entreno',
            calories: 320,
            protein_g: 30,
            carbs_g: 25,
            fat_g: 8,
            order: 2,
            nutritional_badges: ['Pre-entreno'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-yogurt', quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-banana', quantity: 80,  unit: 'g' },
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
            order: 3,
            nutritional_badges: ['Alto en proteína', 'Bajo en grasa'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-chicken',  quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-rice',     quantity: 150, unit: 'g' },
                { ingredient_id: 'ing-broccoli', quantity: 200, unit: 'g' },
              ],
            },
          },
          {
            type: 'DINNER',
            name: 'Cena de recuperación',
            calories: 650,
            protein_g: 55,
            carbs_g: 55,
            fat_g: 18,
            order: 4,
            nutritional_badges: ['Recuperación muscular'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-salmon',       quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-sweet-potato', quantity: 200, unit: 'g' },
                { ingredient_id: 'ing-spinach',      quantity: 100, unit: 'g' },
              ],
            },
          },
        ],
      },
    },
  });

  // Plan Ligero 1800kcal (días de descanso)
  await prisma.diet.upsert({
    where: { id: 'diet-light-1800' },
    update: {},
    create: {
      id: 'diet-light-1800',
      name: 'Plan Ligero 1800kcal',
      total_calories: 1800,
      total_protein_g: 160,
      total_carbs_g: 180,
      total_fat_g: 55,
      meals: {
        create: [
          {
            type: 'BREAKFAST',
            name: 'Desayuno ligero',
            calories: 420,
            protein_g: 28,
            carbs_g: 50,
            fat_g: 12,
            order: 1,
            nutritional_badges: ['Ligero', 'Equilibrado'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-oats', quantity: 70,  unit: 'g' },
                { ingredient_id: 'ing-egg',  quantity: 150, unit: 'g' },
              ],
            },
          },
          {
            type: 'LUNCH',
            name: 'Almuerzo nutritivo',
            calories: 620,
            protein_g: 55,
            carbs_g: 60,
            fat_g: 18,
            order: 2,
            nutritional_badges: ['Alto en proteína'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-tuna',    quantity: 160, unit: 'g' },
                { ingredient_id: 'ing-pasta',   quantity: 120, unit: 'g' },
                { ingredient_id: 'ing-spinach', quantity: 100, unit: 'g' },
              ],
            },
          },
          {
            type: 'SNACK',
            name: 'Snack recuperación',
            calories: 250,
            protein_g: 22,
            carbs_g: 20,
            fat_g: 8,
            order: 3,
            nutritional_badges: [],
            ingredients: {
              create: [
                { ingredient_id: 'ing-yogurt', quantity: 200, unit: 'g' },
              ],
            },
          },
          {
            type: 'DINNER',
            name: 'Cena ligera',
            calories: 510,
            protein_g: 45,
            carbs_g: 40,
            fat_g: 14,
            order: 4,
            nutritional_badges: ['Bajo en calorías'],
            ingredients: {
              create: [
                { ingredient_id: 'ing-chicken',  quantity: 150, unit: 'g' },
                { ingredient_id: 'ing-broccoli', quantity: 250, unit: 'g' },
                { ingredient_id: 'ing-rice',     quantity: 80,  unit: 'g' },
              ],
            },
          },
        ],
      },
    },
  });

  console.log('✅ Diets seeded');

  // ── Achievements ───────────────────────────────────────────────────────────
  await Promise.all([
    prisma.achievement.upsert({ where: { id: 'ach-first-workout' }, update: {}, create: { id: 'ach-first-workout', name: 'Primer entrenamiento', description: 'Completaste tu primer entrenamiento', criteria_type: 'trainings_completed', criteria_value: 1 } }),
    prisma.achievement.upsert({ where: { id: 'ach-week-streak' }, update: {}, create: { id: 'ach-week-streak', name: 'Racha semanal', description: 'Mantuviste una racha de 7 días', criteria_type: 'streak_days', criteria_value: 7 } }),
    prisma.achievement.upsert({ where: { id: 'ach-month-streak' }, update: {}, create: { id: 'ach-month-streak', name: 'Mes de constancia', description: 'Mantuviste una racha de 30 días', criteria_type: 'streak_days', criteria_value: 30 } }),
    prisma.achievement.upsert({ where: { id: 'ach-10-workouts' }, update: {}, create: { id: 'ach-10-workouts', name: 'En forma', description: 'Completaste 10 entrenamientos', criteria_type: 'trainings_completed', criteria_value: 10 } }),
    prisma.achievement.upsert({ where: { id: 'ach-5-streak' }, update: {}, create: { id: 'ach-5-streak', name: 'Constancia inicial', description: 'Mantuviste una racha de 5 días', criteria_type: 'streak_days', criteria_value: 5 } }),
    prisma.achievement.upsert({ where: { id: 'ach-hiit-warrior' }, update: {}, create: { id: 'ach-hiit-warrior', name: 'Guerrero HIIT', description: 'Completaste 3 sesiones de HIIT', criteria_type: 'hiit_completed', criteria_value: 3 } }),
  ]);

  console.log('✅ Achievements seeded');

  // ── Users ──────────────────────────────────────────────────────────────────
  const superAdmin = await prisma.user.upsert({
    where: { firebase_uid: FIREBASE_UID_SUPER_ADMIN },
    update: {},
    create: {
      id: 'user-super-admin',
      email: 'superadmin@exom.dev',
      firebase_uid: FIREBASE_UID_SUPER_ADMIN,
      role: 'SUPER_ADMIN',
      auth_provider: 'email',
      profile: { create: { first_name: 'Super', last_name: 'Admin' } },
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
      profile: { create: { first_name: 'Carlos', last_name: 'Entrenador' } },
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
          last_name: 'López',
          current_weight: 68.5,
          height: 165,
          main_goal: 'Perder grasa y tonificar el cuerpo',
          level: 'PRINCIPIANTE',
          target_calories: 1800,
        },
      },
    },
  });

  console.log(`✅ Users: ${superAdmin.email}, ${adminUser.email}, ${clientUser.email}`);

  // ── Admin-Client Assignment ────────────────────────────────────────────────
  await prisma.adminClientAssignment.upsert({
    where: { admin_id_client_id: { admin_id: adminUser.id, client_id: clientUser.id } },
    update: {},
    create: { admin_id: adminUser.id, client_id: clientUser.id },
  });

  console.log(`✅ AdminClientAssignment: ${adminUser.email} → ${clientUser.email}`);

  // ── Plan Assignments María — 7 días ────────────────────────────────────────
  //
  // Hoy    HIIT                + Ligero 1800
  // +1     Full Body A         + Rendimiento 2500
  // +2     DESCANSO            + Ligero 1800
  // +3     HIIT                + Ligero 1800
  // +4     Push A              + Rendimiento 2500
  // +5     DESCANSO            + Ligero 1800
  // +6     Legs A              + Rendimiento 2500
  //
  const weekPlan = [
    { trainingId: 'tr-hiit-a',     dietId: 'diet-light-1800',       isRestDay: false, notes: 'Sesión HIIT. Ve a tu ritmo pero mantén la intensidad.' },
    { trainingId: 'tr-fullbody-a', dietId: 'diet-performance-2500', isRestDay: false, notes: 'Full body. Céntrate en la técnica, no en el peso.' },
    { trainingId: null,            dietId: 'diet-light-1800',       isRestDay: true,  notes: 'Descansa bien. Puedes hacer una caminata suave.' },
    { trainingId: 'tr-hiit-a',     dietId: 'diet-light-1800',       isRestDay: false, notes: 'Segunda sesión HIIT de la semana. ¡Tú puedes!' },
    { trainingId: 'tr-push-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Día de empuje. Usa un peso que te permita hacer bien la técnica.' },
    { trainingId: null,            dietId: 'diet-light-1800',       isRestDay: true,  notes: 'Segundo día de descanso. Duerme 8 horas si puedes.' },
    { trainingId: 'tr-legs-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Cierra la semana con piernas.' },
  ];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const plan = weekPlan[i];

    await prisma.planAssignment.upsert({
      where: { client_id_date: { client_id: clientUser.id, date } },
      update: {},
      create: {
        client_id: clientUser.id,
        admin_id: adminUser.id,
        date,
        training_id: plan.trainingId,
        diet_id: plan.dietId,
        is_rest_day: plan.isRestDay,
        notes: plan.notes,
      },
    });
  }

  console.log('✅ PlanAssignments María: 7 días (HIIT/FullBody/Rest/HIIT/Push/Rest/Legs)');

  // ── Body Metrics María — últimos 7 días (bajando de peso) ─────────────────
  const weightHistoryMaria = [69.3, 69.1, 68.9, 69.0, 68.8, 68.6, 68.5];
  const sleepHistoryMaria  = [6.5,  7.0,  6.8,  7.5,  6.5,  7.0,  7.5];

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - (6 - i));

    await prisma.bodyMetric.upsert({
      where: { id: `bm-maria-day-${i}` },
      update: {},
      create: {
        id: `bm-maria-day-${i}`,
        client_id: clientUser.id,
        date,
        weight_kg: weightHistoryMaria[i],
        sleep_hours: sleepHistoryMaria[i],
        height_cm: 165,
        waist_cm: 72,
        hips_cm: 94,
        thigh_cm: 57,
      },
    });
  }

  console.log('✅ BodyMetrics María: 7 días de historial');

  // ── Streak María ───────────────────────────────────────────────────────────
  await prisma.streak.upsert({
    where: { client_id: clientUser.id },
    update: { current_days: 2, longest_days: 2, last_active_date: yesterday },
    create: {
      client_id: clientUser.id,
      current_days: 2,
      longest_days: 2,
      last_active_date: yesterday,
    },
  });

  console.log('✅ Streak María: 2 días');

  // ── Challenges para María ─────────────────────────────────────────────────
  const challengeMariaGoal = await prisma.challenge.upsert({
    where: { id: 'ch-maria-objetivo-peso' },
    update: {},
    create: {
      id: 'ch-maria-objetivo-peso',
      title: 'Bajar 3 kg en 8 semanas',
      description: 'Alcanza tu peso objetivo de 65.5 kg siguiendo el plan de dieta y entrenamiento.',
      type: 'MAIN_GOAL',
      target_value: 3,
      unit: 'kg perdidos',
      is_global: false,
      created_by: adminUser.id,
    },
  });

  const challengeMariaWeekly1 = await prisma.challenge.upsert({
    where: { id: 'ch-maria-weekly-entrenos' },
    update: {},
    create: {
      id: 'ch-maria-weekly-entrenos',
      title: '3 entrenamientos esta semana',
      description: 'Completa al menos 3 sesiones de entrenamiento esta semana.',
      type: 'WEEKLY',
      target_value: 3,
      unit: 'sesiones',
      deadline: (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return d; })(),
      created_by: adminUser.id,
    },
  });

  const challengeMariaWeekly2 = await prisma.challenge.upsert({
    where: { id: 'ch-maria-weekly-dieta' },
    update: {},
    create: {
      id: 'ch-maria-weekly-dieta',
      title: 'Seguir la dieta 5 días',
      description: 'Sigue el plan de alimentación al menos 5 días esta semana.',
      type: 'WEEKLY',
      target_value: 5,
      unit: 'días',
      deadline: (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return d; })(),
      created_by: adminUser.id,
    },
  });

  console.log('✅ Challenges María seeded');

  await Promise.all([
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengeMariaGoal.id, client_id: clientUser.id } },
      update: {},
      create: { challenge_id: challengeMariaGoal.id, client_id: clientUser.id, current_value: 0.8 },
    }),
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengeMariaWeekly1.id, client_id: clientUser.id } },
      update: {},
      create: { challenge_id: challengeMariaWeekly1.id, client_id: clientUser.id, current_value: 1 },
    }),
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengeMariaWeekly2.id, client_id: clientUser.id } },
      update: {},
      create: { challenge_id: challengeMariaWeekly2.id, client_id: clientUser.id, current_value: 2 },
    }),
  ]);

  console.log('✅ ChallengeClients María: 3 retos asignados');

  // ════════════════════════════════════════════════════════════════════════════
  // ── SEGUNDO CLIENTE: PEDRO García ───────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════════

  const clientUser2 = await prisma.user.upsert({
    where: { firebase_uid: FIREBASE_UID_CLIENT_2 },
    update: {},
    create: {
      id: 'user-client-2',
      email: 'pedro@exom.dev',
      firebase_uid: FIREBASE_UID_CLIENT_2,
      role: 'CLIENT',
      auth_provider: 'email',
      profile: {
        create: {
          first_name: 'Pedro',
          last_name: 'García',
          current_weight: 81.2,
          height: 178,
          main_goal: 'Ganar masa muscular y reducir grasa corporal',
          level: 'PRINCIPIANTE',
          target_calories: 2500,
        },
      },
    },
  });

  console.log(`✅ User: ${clientUser2.email}`);

  await prisma.adminClientAssignment.upsert({
    where: { admin_id_client_id: { admin_id: adminUser.id, client_id: clientUser2.id } },
    update: {},
    create: { admin_id: adminUser.id, client_id: clientUser2.id },
  });

  console.log(`✅ AdminClientAssignment: ${adminUser.email} → ${clientUser2.email}`);

  // Plan de Pedro — Push/Pull/Legs con 1 descanso
  // Hoy    Push A              + Rendimiento 2500
  // +1     HIIT                + Rendimiento 2500
  // +2     Pull A              + Rendimiento 2500
  // +3     DESCANSO            + Ligero 1800
  // +4     Legs A              + Rendimiento 2500
  // +5     Full Body A         + Rendimiento 2500
  // +6     HIIT                + Ligero 1800
  const weekPlanPedro = [
    { trainingId: 'tr-push-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Día de empuje. Foco en técnica de press de banca.' },
    { trainingId: 'tr-hiit-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Sesión HIIT. Máxima intensidad en los intervalos.' },
    { trainingId: 'tr-pull-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Día de tirón. Recuerda activar la escápula en las dominadas.' },
    { trainingId: null,            dietId: 'diet-light-1800',       isRestDay: true,  notes: 'Día de descanso activo. Puedes caminar 30 min.' },
    { trainingId: 'tr-legs-a',     dietId: 'diet-performance-2500', isRestDay: false, notes: 'Día de piernas. No te saltes el calentamiento.' },
    { trainingId: 'tr-fullbody-a', dietId: 'diet-performance-2500', isRestDay: false, notes: 'Full body. Trabaja la técnica del peso muerto.' },
    { trainingId: 'tr-hiit-a',     dietId: 'diet-light-1800',       isRestDay: false, notes: 'HIIT del domingo. Cierra la semana fuerte.' },
  ];

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const plan = weekPlanPedro[i];

    await prisma.planAssignment.upsert({
      where: { client_id_date: { client_id: clientUser2.id, date } },
      update: {},
      create: {
        client_id: clientUser2.id,
        admin_id: adminUser.id,
        date,
        training_id: plan.trainingId,
        diet_id: plan.dietId,
        is_rest_day: plan.isRestDay,
        notes: plan.notes,
      },
    });
  }

  console.log('✅ PlanAssignments Pedro: 7 días (Push/HIIT/Pull/Rest/Legs/FullBody/HIIT)');

  // Body metrics de Pedro — últimos 7 días (bajando lentamente)
  const weightHistoriaPedro = [82.1, 81.8, 81.5, 81.9, 81.4, 81.3, 81.2];
  const sleepHistoriaPedro  = [7.5,  6.8,  7.2,  8.0,  7.0,  7.5,  8.0];

  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - (6 - i));

    await prisma.bodyMetric.upsert({
      where: { id: `bm-pedro-day-${i}` },
      update: {},
      create: {
        id: `bm-pedro-day-${i}`,
        client_id: clientUser2.id,
        date,
        weight_kg: weightHistoriaPedro[i],
        sleep_hours: sleepHistoriaPedro[i],
        height_cm: 178,
        waist_cm: 83,
        chest_cm: 98,
        arm_cm: 35,
      },
    });
  }

  console.log('✅ BodyMetrics Pedro: 7 días de historial');

  // Streak Pedro — 5 días activos
  await prisma.streak.upsert({
    where: { client_id: clientUser2.id },
    update: { current_days: 5, longest_days: 5, last_active_date: yesterday },
    create: {
      client_id: clientUser2.id,
      current_days: 5,
      longest_days: 5,
      last_active_date: yesterday,
    },
  });

  console.log('✅ Streak Pedro: 5 días');

  // Retos específicos para Pedro
  const challengePedroGoal = await prisma.challenge.upsert({
    where: { id: 'ch-pedro-programa-inicial' },
    update: {},
    create: {
      id: 'ch-pedro-programa-inicial',
      title: 'Completar programa inicial',
      description: 'Completa 12 sesiones de entrenamiento en las próximas 4 semanas.',
      type: 'MAIN_GOAL',
      target_value: 12,
      unit: 'sesiones',
      is_global: false,
      created_by: adminUser.id,
    },
  });

  const challengePedroWeekly1 = await prisma.challenge.upsert({
    where: { id: 'ch-pedro-weekly-entrenos' },
    update: {},
    create: {
      id: 'ch-pedro-weekly-entrenos',
      title: '4 entrenamientos esta semana',
      description: 'Completa al menos 4 sesiones de entrenamiento esta semana.',
      type: 'WEEKLY',
      target_value: 4,
      unit: 'sesiones',
      deadline: (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return d; })(),
      created_by: adminUser.id,
    },
  });

  const challengePedroWeekly2 = await prisma.challenge.upsert({
    where: { id: 'ch-pedro-weekly-hiit' },
    update: {},
    create: {
      id: 'ch-pedro-weekly-hiit',
      title: '2 sesiones HIIT esta semana',
      description: 'Completa 2 sesiones de entrenamiento HIIT durante la semana.',
      type: 'WEEKLY',
      target_value: 2,
      unit: 'sesiones HIIT',
      deadline: (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return d; })(),
      created_by: adminUser.id,
    },
  });

  console.log('✅ Challenges Pedro seeded');

  await Promise.all([
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengePedroGoal.id, client_id: clientUser2.id } },
      update: {},
      create: { challenge_id: challengePedroGoal.id, client_id: clientUser2.id, current_value: 5 },
    }),
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengePedroWeekly1.id, client_id: clientUser2.id } },
      update: {},
      create: { challenge_id: challengePedroWeekly1.id, client_id: clientUser2.id, current_value: 2 },
    }),
    prisma.challengeClient.upsert({
      where: { challenge_id_client_id: { challenge_id: challengePedroWeekly2.id, client_id: clientUser2.id } },
      update: {},
      create: { challenge_id: challengePedroWeekly2.id, client_id: clientUser2.id, current_value: 1 },
    }),
  ]);

  console.log('✅ ChallengeClients Pedro: 3 retos asignados');

  console.log('\n🎉 Seed completado con éxito!');
  console.log('📋 Resumen:');
  console.log('   - 15 ejercicios, 12 ingredientes');
  console.log('   - 5 entrenamientos (FullBody, Push, Pull, Legs, HIIT)');
  console.log('   - 2 dietas (Rendimiento 2500kcal, Ligera 1800kcal)');
  console.log('');
  console.log('   María López (cliente@exom.dev):');
  console.log('   · 7 días: HIIT/FullBody/Rest/HIIT/Push/Rest/Legs');
  console.log('   · Racha 2 días · 3 retos · 68.5kg bajando');
  console.log('');
  console.log('   Pedro García (pedro@exom.dev):');
  console.log('   · 7 días: Push/HIIT/Pull/Rest/Legs/FullBody/HIIT');
  console.log('   · Racha 5 días · 3 retos · 81.2kg bajando');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
