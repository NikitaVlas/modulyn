import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModulesStore } from '../database/modules-store.service.js';
import { MODULE_KEYS } from './registry.js';

/**
 * Сверка реестра модулей с каталогом БД при старте API (6.1, M1).
 * Модуль из реестра без записи в каталоге не может быть включён (проверка включения идёт через каталог),
 * поэтому здесь только предупреждение в лог — старт не прерывается. Лишние записи каталога игнорируются.
 */
@Injectable()
export class ModulesCatalogCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('Modules');

  constructor(private readonly store: ModulesStore) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const catalog = new Set(await this.store.catalogKeys());
      const missing = MODULE_KEYS.filter(k => !catalog.has(k));
      if (missing.length > 0) this.logger.error(`Modules missing in the database catalog (treated as disabled): ${missing.join(', ')}. Run migrations.`);
    } catch {
      this.logger.warn('Module catalog check skipped: database not reachable at startup');
    }
  }
}
