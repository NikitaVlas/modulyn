import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { requireTenant } from '../tenancy/request-context.js';
import { DatabaseService } from './database.service.js';

/** Клиент внутри транзакции компании. Только его получают репозитории tenant-данных. */
export type TenantTx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Доступ к данным компании (подшаги 2.4, 2.5).
 *
 * run(fn): берёт компанию из контекста запроса, открывает транзакцию и первой командой выполняет
 *   SELECT set_config('app.tenant_id', <id>, true)
 * Третий аргумент true означает «только до конца транзакции», поэтому значение не переживёт транзакцию
 * и не попадёт к следующему запросу, который получит то же соединение из пула.
 * RLS-политики PostgreSQL видят только строки этой компании, даже если в запросе забыт фильтр по tenantId.
 */
@Injectable()
export class TenantDb {
  constructor(private readonly database: DatabaseService) {}

  /** Транзакция в контексте компании текущего запроса. Без контекста — MissingTenantContextError до любого SQL. */
  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    const tenant = requireTenant();
    return this.runInTenant(tenant.tenantId, fn);
  }

  /**
   * Явный контекст компании для кода без HTTP-запроса (фоновые задачи, platform-операции, seed, тесты).
   * Вызывающий отвечает за то, что tenantId получен с сервера, а не от клиента.
   */
  async runInTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) throw new Error('Invalid tenant id');
    await this.database.assertRuntimeRole();
    return this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }, { maxWait: 5000, timeout: 10000 });
  }
}
