import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { initFirebase } from './config/firebase.config';
import { configureApp } from './configure-app';

async function bootstrap() {
  initFirebase();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: false,
  });
  try {
    configureApp(app);
    app.enableShutdownHooks();
    await app.listen(process.env.PORT ?? 3000);
  } catch (error) {
    await app.close();
    throw error;
  }
}

bootstrap().catch(() => {
  console.error('API startup failed');
  process.exitCode = 1;
});
