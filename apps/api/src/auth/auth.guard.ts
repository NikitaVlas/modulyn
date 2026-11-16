import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { currentRequestContext, type ContextKind, type TenantRole } from '../tenancy/request-context.js';
import { CONTEXTS_KEY, PUBLIC_KEY, ROLES_KEY } from './decorators.js';
import { SessionsService } from './sessions.service.js';

/**
 * Глобальный guard (подшаг 3.5). Порядок проверок:
 * 1. Маршрут доступен на этом типе хоста (@Contexts), иначе 404 — как будто маршрута нет.
 * 2. @Public() — без входа.
 * 3. Access-токен своего контекста: подпись ключом контекста, aud, срок; для компании — tid совпадает с компанией hostname.
 * 4. Сессия в БД действует, аккаунт активен; для компании — участие в ЭТОЙ компании активно. Иначе 401.
 * 5. @Roles(...) — роль из БД (не из токена). Иначе 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: SessionsService) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const targets = [execution.getHandler(), execution.getClass()];
    const context = currentRequestContext();
    const allowed = this.reflector.getAllAndOverride<ContextKind[] | undefined>(CONTEXTS_KEY, targets);
    if (allowed && (!context || !allowed.includes(context.kind))) throw new NotFoundException();
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets)) return true;
    if (!context) throw new NotFoundException();

    const req = execution.switchToHttp().getRequest<Request>();
    if (context.kind === 'tenant') {
      const principal = await this.sessions.authenticateTenant(req, context.tenant);
      if (!principal) throw new UnauthorizedException();
      context.principal = principal;
      const roles = this.reflector.getAllAndOverride<TenantRole[] | undefined>(ROLES_KEY, targets);
      if (roles && !roles.includes(principal.role)) throw new ForbiddenException();
      return true;
    }
    if (this.reflector.getAllAndOverride<TenantRole[] | undefined>(ROLES_KEY, targets)) throw new ForbiddenException();
    if (context.kind === 'app') {
      const principal = await this.sessions.authenticateApp(req);
      if (!principal) throw new UnauthorizedException();
      context.principal = principal;
      return true;
    }
    const principal = await this.sessions.authenticatePlatform(req);
    if (!principal) throw new UnauthorizedException();
    context.principal = principal;
    return true;
  }
}
