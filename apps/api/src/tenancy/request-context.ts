import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст текущего HTTP-запроса (подшаги 2.4, 3.5).
 * AsyncLocalStorage хранит значение для всей асинхронной цепочки одного запроса, поэтому параллельные
 * запросы разных компаний не видят контекст друг друга, и его не нужно передавать параметром.
 */
export interface TenantRef {
  tenantId: string;
  slug: string;
  displayName: string;
}

export type TenantRole = 'TENANT_ADMIN' | 'MANAGER';

/**
 * Ограничение сессии до завершения обязательных шагов (Phase 4):
 * password-change — вход временным паролем (B8); mfa-setup — администратор платформы ещё не настроил второй фактор (B2).
 * Пока ограничение есть, guard пропускает только маршруты с @AllowRestricted.
 */
export type Restriction = 'password-change' | 'mfa-setup';

/** Кто выполняет запрос. Заполняется guard аутентификации после проверки токена и сессии в БД. */
export interface TenantPrincipal { userId: string; sessionId: string; role: TenantRole; restricted?: Restriction }
export interface AppPrincipal { userId: string; sessionId: string; restricted?: Restriction }
export interface PlatformPrincipal { adminId: string; sessionId: string; restricted?: Restriction }

export function restrictionOf(state: { passwordChangeRequired: boolean; mfaSetupRequired: boolean }): Restriction | undefined {
  if (state.passwordChangeRequired) return 'password-change';
  if (state.mfaSetupRequired) return 'mfa-setup';
  return undefined;
}

/**
 * host — исходный Host запроса (с портом), как его видел браузер; нужен для проверки Origin (A7).
 * ip — адрес клиента для ограничения входа (A9).
 */
interface Common { host?: string; ip?: string | undefined }

export type RequestContext =
  | (Common & { kind: 'tenant'; tenant: TenantRef; principal?: TenantPrincipal })
  | (Common & { kind: 'platform'; principal?: PlatformPrincipal })
  | (Common & { kind: 'app'; principal?: AppPrincipal });

export type ContextKind = RequestContext['kind'];

/** Ошибка программиста: tenant-операция вызвана вне контекста компании. Отказ до любого SQL. */
export class MissingTenantContextError extends Error {
  constructor() {
    super('Tenant context is required for this operation');
    this.name = 'MissingTenantContextError';
  }
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentTenant(): TenantRef | undefined {
  const context = storage.getStore();
  return context?.kind === 'tenant' ? context.tenant : undefined;
}

export function requireTenant(): TenantRef {
  const tenant = currentTenant();
  if (!tenant) throw new MissingTenantContextError();
  return tenant;
}
