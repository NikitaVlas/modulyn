import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { parseEnvironment } from '../config/environment.js';
import { PrismaClient } from '../generated/prisma/client.js';

/** Подключение работает под ролью, которая обходит RLS: суперпользователь, BYPASSRLS или владелец таблиц. */
export class UnsafeDatabaseRoleError extends Error {
  constructor() {
    super('DATABASE_URL role can bypass row-level security');
    this.name = 'UnsafeDatabaseRoleError';
  }
}

/**
 * Единственный владелец PrismaClient (подшаги 2.2, 2.5).
 * Бизнес-код не получает этот клиент: tenant-данные доступны только через TenantDb, глобальные —
 * через узкие репозитории модуля database. Импорт сгенерированного клиента вне src/database запрещён ESLint.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger('Database');
  readonly client: PrismaClient;
  private roleCheck: Promise<void> | undefined;

  constructor() {
    const adapter = new PrismaPg({
      connectionString: parseEnvironment(process.env).databaseUrl,
      max: 10,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });
    this.client = new PrismaClient({ adapter });
  }

  /** Readiness: реальный запрос к БД и проверка, что runtime-роль не обходит RLS. */
  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
    await this.assertRuntimeRole();
  }

  /**
   * Fail-closed проверка роли. Результат кешируется после успеха; при ошибке соединения повторяется.
   * Если роль небезопасна, все tenant-операции и readiness отказывают, а в лог пишется понятная причина без секретов.
   */
  assertRuntimeRole(): Promise<void> {
    this.roleCheck ??= this.checkRole().catch((error: unknown) => {
      if (!(error instanceof UnsafeDatabaseRoleError)) this.roleCheck = undefined;
      throw error;
    });
    return this.roleCheck;
  }

  private async checkRole(): Promise<void> {
    const rows = await this.client.$queryRaw<{ unsafe: boolean }[]>`
      SELECT (r.rolsuper OR r.rolbypassrls OR EXISTS (
                SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user
              )) AS unsafe
      FROM pg_roles r WHERE r.rolname = current_user`;
    if (rows[0]?.unsafe !== false) {
      this.logger.error('DATABASE_URL must use the runtime role (modulyn_app): the current role bypasses row-level security.');
      throw new UnsafeDatabaseRoleError();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
