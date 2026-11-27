import { Injectable } from '@nestjs/common';
import type { Locale } from '@modulyn/i18n';
import { requestLocale } from '../i18n.js';
import { TokensService } from '../auth/tokens.service.js';
import { originFor, parseEnvironment } from '../config/environment.js';
import { MembersStore } from '../database/members-store.service.js';
import { MailService } from '../mail/mail.service.js';
import { invitationMail } from '../mail/templates.js';
import type { TenantRole } from '../tenancy/request-context.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITATIONS_PER_DAY = 50;

/**
 * Выдача приглашений (5.2, C3, C8, C10). Используется администратором компании и платформой.
 * Токен — 256 бит, в БД только SHA-256. Ссылка — `app.<домен>/invite#<токен>`: часть после # браузер
 * не отправляет на сервер, поэтому токен не попадает в логи прокси и в Referer.
 */
@Injectable()
export class InvitationsService {
  private readonly env = parseEnvironment(process.env);
  private readonly appOrigin = originFor(this.env, 'app');

  constructor(private readonly store: MembersStore, private readonly tokens: TokensService, private readonly mail: MailService) {}

  newToken(): { token: string; tokenHash: string; expiresAt: Date } {
    const token = this.tokens.randomToken();
    return { token, tokenHash: this.tokens.hash(token), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) };
  }

  link(token: string): string {
    return `${this.appOrigin}/invite#${token}`;
  }

  /** Phase 10 (I4): язык приглашения — язык того, кто приглашает (администратор компании или платформы). */
  async issue(tenantId: string, companyName: string, input: { email: string; name: string; role: TenantRole }, inviter: { userId: string; name: string } | null): Promise<boolean> {
    const { token, tokenHash, expiresAt } = this.newToken();
    const locale = requestLocale();
    await this.store.createInvitation(tenantId, { ...input, tokenHash, expiresAt, invitedById: inviter?.userId ?? null, locale });
    return this.sendInvitation(input.email, companyName, inviter?.name ?? null, token, locale);
  }

  sendInvitation(email: string, companyName: string, inviterName: string | null, token: string, locale: Locale): Promise<boolean> {
    return this.mail.send(invitationMail({ to: email, companyName, inviterName, link: this.link(token), locale, brand: this.env.brand }));
  }
}
