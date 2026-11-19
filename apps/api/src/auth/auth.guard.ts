import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { currentRequestContext, type ContextKind, type Restriction, type TenantRole } from '../tenancy/request-context.js';
import { ModulesStore } from '../database/modules-store.service.js';
import { t } from '../i18n.js';
import type { ModuleKey } from '../modules/registry.js';
import { ALLOW_RESTRICTED_KEY, CONTEXTS_KEY, MODULE_KEY, PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import { SessionsService } from './sessions.service.js';

const RESTRICTION_CODE: Record<Restriction, string> = {
  'password-change': 'PASSWORD_CHANGE_REQUIRED',
  'mfa-setup': 'MFA_SETUP_REQUIRED',
};

/**
 * Глобальный guard (подшаги 3.5, 4.1). Порядок проверок:
 * 1. Маршрут доступен на этом типе хоста (@Contexts), иначе 404 — как будто маршрута нет.
 * 2. @Public() — без входа.
 * 3. Access-токен своего контекста: подпись ключом контекста, aud, срок; для компании — tid совпадает с компанией hostname.
 * 4. Сессия в БД действует, аккаунт активен; для компании — участие в ЭТОЙ компании активно. Иначе 401.
 * 5. Незавершённый обязательный шаг (временный пароль, настройка второго фактора) — только @AllowRestricted, иначе 403.
 * 6. @Roles(...) — роль из БД (не из токена). Иначе 403.
 * 7. @RequireModule(...) — модуль включён у компании. Иначе 403 MODULE_DISABLED.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionsService, private readonly modules: ModulesStore) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const targets = [execution.getHandler(), execution.getClass()];
    const context = currentRequestContext();
    const allowed = this.reflector.getAllAndOverride<ContextKind[] | undefined>(CONTEXTS_KEY, targets);
    if (allowed && (!context || !allowed.includes(context.kind))) throw new NotFoundException();
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets)) return true;
    if (!context) throw new NotFoundException();

    const req = execution.switchToHttp().getRequest<Request>();
    const principal = context.kind === 'tenant'
      ? await this.sessions.authenticateTenant(req, context.tenant)
      : context.kind === 'app' ? await this.sessions.authenticateApp(req) : await this.sessions.authenticatePlatform(req);
    if (!principal) throw new UnauthorizedException();
    (context as { principal?: typeof principal }).principal = principal;
    context.locale = principal.locale; // Phase 10 (I2): ответы — на языке аккаунта

    if (principal.restricted) {
      const permitted = this.reflector.getAllAndOverride<Restriction[] | undefined>(ALLOW_RESTRICTED_KEY, targets) ?? [];
      if (!permitted.includes(principal.restricted)) {
        throw new ForbiddenException({ statusCode: 403, message: 'Forbidden', code: RESTRICTION_CODE[principal.restricted] });
      }
    }

    const roles = this.reflector.getAllAndOverride<TenantRole[] | undefined>(ROLES_KEY, targets);
    if (roles) {
      if (context.kind !== 'tenant' || !context.principal || !roles.includes(context.principal.role)) throw new ForbiddenException();
    }

    // 7. Модуль маршрута включён у этой компании (Phase 6, M4, M6). Проверяется после входа: без входа — 401.
    const module = this.reflector.getAllAndOverride<ModuleKey | undefined>(MODULE_KEY, targets);
    if (module) {
      if (context.kind !== 'tenant' || !(await this.modules.isEnabled(context.tenant.tenantId, module))) {
        throw new ForbiddenException({ statusCode: 403, message: t('err.moduleDisabled'), code: 'MODULE_DISABLED' });
      }
    }
    return true;
  }
}
