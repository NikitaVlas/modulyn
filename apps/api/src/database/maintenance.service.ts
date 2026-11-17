import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_MS = 60 * 1000;

/**
 * Очистка устаревших технических записей (Phase 9, F5, F7): раз в час вызывает функцию БД modulyn_cleanup().
 * Правила и сроки — в функции (миграция 20261117120000_phase9_retention); у приложения нет прав DELETE на журналы и сессии.
 * Несколько экземпляров API безопасны: функция берёт блокировку, второй вызов получает {"skipped": true}.
 * В лог — только числа удалённых записей. В тестах таймер не запускается (вызов — напрямую).
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Maintenance');
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.cleanup().catch(() => this.logger.warn('Cleanup skipped: database not reachable')).finally(() => schedule(HOUR_MS));
      }, delay);
      this.timer.unref();
    };
    schedule(FIRST_RUN_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async cleanup(): Promise<Record<string, number | boolean>> {
    await this.database.assertRuntimeRole();
    const rows = await this.database.client.$queryRaw<{ result: Record<string, number | boolean> }[]>`SELECT modulyn_cleanup() AS result`;
    const result = rows[0]?.result ?? {};
    const removed = Object.entries(result).filter(([, n]) => typeof n === 'number' && n > 0);
    if (removed.length > 0) this.logger.log(`Cleanup removed: ${removed.map(([k, n]) => `${k}=${String(n)}`).join(', ')}`);
    return result;
  }
}
