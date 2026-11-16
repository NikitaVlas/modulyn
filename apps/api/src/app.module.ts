import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { GoogleService } from './auth/google.service.js';
import { OriginMiddleware } from './auth/origin.middleware.js';
import { PasswordService } from './auth/password.service.js';
import { SessionsService } from './auth/sessions.service.js';
import { ThrottleService } from './auth/throttle.service.js';
import { TokensService } from './auth/tokens.service.js';
import { AuthStore } from './database/auth-store.service.js';
import { DatabaseService } from './database/database.service.js';
import { TenantDb } from './database/tenant-db.service.js';
import { TenantDirectory } from './database/tenant-directory.service.js';
import { PlatformStore } from './database/platform-store.service.js';
import { MembersStore } from './database/members-store.service.js';
import { HealthController } from './health/health.controller.js';
import { InvitationsController } from './auth/invitations.controller.js';
import { MailService } from './mail/mail.service.js';
import { InvitationsService } from './members/invitations.service.js';
import { MembersController } from './members/members.controller.js';
import { PlatformTenantsController } from './platform/tenants.controller.js';
import { TenancyMiddleware } from './tenancy/tenancy.middleware.js';
import { TenantController } from './tenancy/tenant.controller.js';

@Module({
  controllers: [HealthController, TenantController, AuthController, InvitationsController, MembersController, PlatformTenantsController],
  providers: [
    DatabaseService, TenantDb, TenantDirectory, TenancyMiddleware, PlatformStore, MembersStore, MailService, InvitationsService,
    AuthStore, PasswordService, TokensService, SessionsService, ThrottleService, GoogleService, OriginMiddleware,
    // Все маршруты по умолчанию требуют входа; открытые помечены @Public() (подшаг 3.5).
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
