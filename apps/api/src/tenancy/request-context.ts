import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Контекст текущего HTTP-запроса (подшаг 2.4).
 * AsyncLocalStorage хранит значение для всей асинхронной цепочки одного запроса, поэтому параллельные
 * запросы разных компаний не видят контекст друг друга, и его не нужно передавать параметром.
 */
export interface TenantRef {
  tenantId: string;
  slug: string;
  displayName: string;
}

export type RequestContext =
  | { kind: 'tenant'; tenant: TenantRef }
  | { kind: 'platform' }
  | { kind: 'app' };

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
