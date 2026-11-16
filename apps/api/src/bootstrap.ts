import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { TenancyMiddleware } from './tenancy/tenancy.middleware.js';

export async function createApplication() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  // Определение компании по Host выполняется для всех маршрутов до контроллеров (кроме /api/health*).
  app.use(app.get(TenancyMiddleware).handle);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
