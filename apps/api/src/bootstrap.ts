import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { OriginMiddleware } from './auth/origin.middleware.js';
import { TenancyMiddleware } from './tenancy/tenancy.middleware.js';

export async function createApplication() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  // Определение компании по Host выполняется для всех маршрутов до контроллеров (кроме /api/health*).
  app.use(app.get(TenancyMiddleware).handle);
  // Проверка Origin и Content-Type изменяющих запросов (CSRF, подшаг 3.6) — после определения хоста.
  app.use(app.get(OriginMiddleware).handle);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
