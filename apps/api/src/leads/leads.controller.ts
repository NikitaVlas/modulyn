import { Controller, Get } from '@nestjs/common';
import type { LeadsSummaryResponse } from '@modulyn/contracts';
import { Contexts, RequireModule } from '../auth/decorators.js';
import { LeadsStore } from '../database/leads-store.service.js';

/**
 * Модуль «Заявки» (Phase 6: M8 — сводка; Phase 7 — остальное).
 * @RequireModule на классе: любой маршрут этого контроллера закрыт, если модуль у компании отключён.
 * По A2 сводку видят и менеджер, и администратор компании.
 */
@Contexts('tenant')
@RequireModule('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsStore) {}

  @Get('summary')
  summary(): Promise<LeadsSummaryResponse> {
    return this.leads.summary();
  }
}
