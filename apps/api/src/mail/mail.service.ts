import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { parseEnvironment } from '../config/environment.js';

export interface MailMessage { to: string; subject: string; text: string; html: string }

/** smtp://user:pass@host:587 (STARTTLS по возможности) или smtps://…:465 (TLS сразу); короткие таймауты. */
function smtpOptions(url: string) {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname, port: Number(u.port || (secure ? 465 : 587)), secure,
    ...(u.username ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  };
}

/**
 * Отправка писем (подшаг 5.7, решение C1). Любой почтовый сервис через SMTP — CRM от поставщика не зависит.
 * Локально — Mailpit (перехватывает письма); в тестах — memory: (письма в outbox процесса).
 *
 * Отправка не бросает исключений: false означает «не доставлено почтовому серверу». В лог пишется только
 * факт и код ошибки — без адреса, текста и ссылок (в ссылках одноразовые токены).
 */
@Injectable()
export class MailService implements OnApplicationShutdown {
  private readonly logger = new Logger('Mail');
  private readonly from: string;
  private readonly transport: Transporter | undefined;
  /** Только для memory: — тесты читают отправленные письма отсюда. */
  readonly outbox: MailMessage[] = [];
  private readonly memory: boolean;

  constructor() {
    const env = parseEnvironment(process.env);
    this.from = env.mailFrom;
    this.memory = env.smtpUrl?.startsWith('memory:') ?? false;
    this.transport = env.smtpUrl && !this.memory ? nodemailer.createTransport(smtpOptions(env.smtpUrl)) : undefined;
  }

  get enabled(): boolean { return this.memory || this.transport !== undefined; }

  async send(message: MailMessage): Promise<boolean> {
    if (this.memory) { this.outbox.push(message); return true; }
    if (!this.transport) {
      this.logger.warn('Mail is not configured (SMTP_URL): message not sent');
      return false;
    }
    try {
      await this.transport.sendMail({ from: this.from, ...message });
      return true;
    } catch (error) {
      this.logger.error(`Mail delivery failed: ${(error as { code?: string }).code ?? (error as Error).name}`);
      return false;
    }
  }

  onApplicationShutdown(): void { this.transport?.close(); }
}
