import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { StreakCalculatorService } from '../src/modules/streaks/streak-calculator.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const calculator = app.get(StreakCalculatorService);
    const count = await calculator.recalculateAllHistory();
    console.log(`Recalculated streaks for ${count} clients.`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
