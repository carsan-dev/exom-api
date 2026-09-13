import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { initFirebase } from './config/firebase.config';
import { configureApp } from './configure-app';
import { startupError, StartupStage } from './startup-error';

export async function bootstrap() {
  let stage: StartupStage = 'firebase';
  let app: NestExpressApplication | undefined;
  try {
    initFirebase();
    stage = 'dependencies';
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      abortOnError: false,
    });
    stage = 'configuration';
    configureApp(app);
    app.enableShutdownHooks();
    stage = 'listen';
    await app.listen(process.env.PORT ?? 3000);
  } catch (error) {
    const failure = startupError(stage, error);
    if (app) {
      try {
        await app.close();
      } catch {
        console.error('API startup cleanup failed; original failure preserved');
      }
    }
    throw failure;
  }
}
