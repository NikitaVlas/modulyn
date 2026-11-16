import { Module } from '@nestjs/common';
import { DatabaseService } from './database/database.service.js';
import { TenantDb } from './database/tenant-db.service.js';
import { TenantDirectory } from './database/tenant-directory.service.js';
import { HealthController } from './health/health.controller.js';
import { TenancyMiddleware } from './tenancy/tenancy.middleware.js';
import { TenantController } from './tenancy/tenant.controller.js';

@Module({
  controllers: [HealthController, TenantController],
  providers: [DatabaseService, TenantDb, TenantDirectory, TenancyMiddleware],
})
export class AppModule {}
