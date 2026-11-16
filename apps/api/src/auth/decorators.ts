import { SetMetadata, createParamDecorator } from '@nestjs/common';
import { currentRequestContext, type AppPrincipal, type ContextKind, type PlatformPrincipal, type TenantPrincipal, type TenantRole } from '../tenancy/request-context.js';

export const PUBLIC_KEY = 'modulyn:public';
export const CONTEXTS_KEY = 'modulyn:contexts';
export const ROLES_KEY = 'modulyn:roles';

/**
 * По умолчанию все маршруты требуют входа (guard глобальный). @Public() снимает проверку явно:
 * забытый декоратор закрывает доступ, а не открывает.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Маршрут существует только на перечисленных хостах (tenant / app / platform); на остальных — 404. */
export const Contexts = (...kinds: ContextKind[]) => SetMetadata(CONTEXTS_KEY, kinds);

/** Роли в компании, которым разрешён маршрут (только tenant-контекст). Нет роли — 403. */
export const Roles = (...roles: TenantRole[]) => SetMetadata(ROLES_KEY, roles);

/** Проверенный guard'ом пользователь компании. */
export const CurrentTenantUser = createParamDecorator((): TenantPrincipal => {
  const context = currentRequestContext();
  if (context?.kind !== 'tenant' || !context.principal) throw new Error('Tenant principal is required');
  return context.principal;
});

export const CurrentAppUser = createParamDecorator((): AppPrincipal => {
  const context = currentRequestContext();
  if (context?.kind !== 'app' || !context.principal) throw new Error('App principal is required');
  return context.principal;
});

export const CurrentPlatformAdmin = createParamDecorator((): PlatformPrincipal => {
  const context = currentRequestContext();
  if (context?.kind !== 'platform' || !context.principal) throw new Error('Platform principal is required');
  return context.principal;
});
