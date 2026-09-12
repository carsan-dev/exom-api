import * as path from 'path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ApprovalInterceptor } from './common/interceptors/approval.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { UploadsService } from './modules/uploads/uploads.service';

export function configureApp(app: NestExpressApplication): void {
  // Global prefix
  app.setGlobalPrefix('api/v1');

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global response transform interceptor
  app.useGlobalInterceptors(
    new TransformInterceptor(app.get(UploadsService)),
    app.get(ApprovalInterceptor),
  );

  // Swagger
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('EXOM API')
      .setDescription(
        'API REST para la plataforma EXOM de entrenamiento personal y nutrición',
      )
      .setVersion('1.0.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase Auth JWT',
      })
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Serve uploaded files locally in dev
  if (process.env.NODE_ENV !== 'production') {
    app.useStaticAssets(path.join(process.cwd(), 'uploads'), {
      prefix: '/api/v1/uploads/local',
    });
  }
}
