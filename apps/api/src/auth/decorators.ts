import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ModuleKey } from '../modules/registry.js';
import { currentRequestContext, type AppPrincipal, type ContextKind, type PlatformPrincipal, type Restriction, type TenantPrincipal, type TenantRole } from '../tenancy/request-context.js';

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

export const MODULE_KEY = 'modulyn:module';
/**
 * Маршрут принадлежит модулю (Phase 6, M6): при отключённом у компании модуле — 403 MODULE_DISABLED.
 * Ставится на класс контроллера модуля, чтобы новый маршрут не остался без защиты.
 */
export const RequireModule = (key: ModuleKey) => SetMetadata(MODULE_KEY, key);

export const ALLOW_RESTRICTED_KEY = 'modulyn:allow-restricted';
/**
 * Маршрут доступен сессии с незавершённым обязательным шагом (временный пароль, настройка второго фактора).
 * Без декоратора такая сессия получает 403 с кодом PASSWORD_CHANGE_REQUIRED или MFA_SETUP_REQUIRED.
 */
export const AllowRestricted = (...restrictions: Restriction[]) => SetMetadata(ALLOW_RESTRICTED_KEY, restrictions);

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
