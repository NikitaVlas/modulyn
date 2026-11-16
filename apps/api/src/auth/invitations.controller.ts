import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { InvitationAcceptResponse, InvitationInspectResponse } from '@modulyn/contracts';
import { AuthStore } from '../database/auth-store.service.js';
import { MembersStore } from '../database/members-store.service.js';
import { OIDC_STATE_TTL_MS } from './auth.constants.js';
import { setCookie } from './cookies.js';
import { Contexts, Public } from './decorators.js';
import { GoogleService } from './google.service.js';
import { PasswordService, passwordPolicyError } from './password.service.js';
import { SessionsService } from './sessions.service.js';
import { TokensService } from './tokens.service.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const INVALID_LINK = 'Ссылка недействительна или устарела. Попросите администратора отправить приглашение ещё раз.';

function token(body: unknown): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).token : undefined;
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new NotFoundException(INVALID_LINK);
  return value;
}

/**
 * Приглашение по ссылке из письма (5.2, C2, C10) на app.<домен>. Токен приходит в теле POST-запроса:
 * в адресе страницы он стоит после #, поэтому не попадает на сервер при открытии страницы.
 *
 * Новый человек задаёт имя и пароль (или входит через Google с тем же email) — аккаунт создаётся с
 * подтверждённым email. Существующий аккаунт принимает приглашение только после входа и только если
 * email аккаунта совпадает с email приглашения.
 */
@Contexts('app')
@Controller('invitations')
export class InvitationsController {
  constructor(
    private readonly members: MembersStore,
    private readonly store: AuthStore,
    private readonly sessions: SessionsService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokensService,
    private readonly google: GoogleService,
  ) {}

  @Public() @Post('inspect') @HttpCode(200)
  async inspect(@Body() body: unknown, @Req() req: Request): Promise<InvitationInspectResponse> {
    const info = await this.members.inspect(this.tokens.hash(token(body)));
    if (!info) throw new NotFoundException(INVALID_LINK);
    const principal = await this.sessions.authenticateApp(req);
    const signedInAs = principal ? (await this.store.findUserById(principal.userId))?.email ?? null : null;
    return {
      companyName: info.tenantName, email: info.email, name: info.name, role: info.role,
      status: info.open && info.tenantActive ? 'open' : 'used',
      accountExists: (await this.store.findUserByEmail(info.email)) !== null,
      signedInAs, google: this.google.enabled,
    };
  }

  @Public() @Post('accept') @HttpCode(200)
  async accept(@Body() raw: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<InvitationAcceptResponse> {
    const tokenHash = this.tokens.hash(token(raw));
    const body = raw as Record<string, unknown>;
    const info = await this.members.inspect(tokenHash);
    if (!info || !info.open || !info.tenantActive) throw new BadRequestException(INVALID_LINK);

    const principal = await this.sessions.authenticateApp(req);
    if (principal) {
      const user = await this.store.findUserById(principal.userId);
      if (!user || user.email !== info.email) throw new ForbiddenException('Приглашение отправлено на другой email. Выйдите и войдите нужным аккаунтом.');
      const result = await this.members.accept(tokenHash, { kind: 'existing', userId: user.id }, info.email);
      if (!result) throw new BadRequestException(INVALID_LINK);
      return { tenantSlug: result.tenantSlug };
    }

    if (await this.store.findUserByEmail(info.email)) throw new ConflictException('У вас уже есть аккаунт. Войдите, чтобы принять приглашение.');
    const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : info.name;
    if (name.length > 200) throw new BadRequestException('Имя длиннее 200 символов');
    const password = typeof body.password === 'string' ? body.password : '';
    const policy = passwordPolicyError(password);
    if (policy) throw new BadRequestException(policy);
    const result = await this.members.accept(tokenHash, { kind: 'new', name, passwordHash: await this.passwords.hash(password) }, info.email);
    if (!result) throw new BadRequestException(INVALID_LINK);
    await this.sessions.startApp(res, result.userId);
    return { tenantSlug: result.tenantSlug };
  }

  /** Принять через Google: возвращает адрес Google; после возврата callback проверит, что email совпадает. */
  @Public() @Post('google') @HttpCode(200)
  async acceptWithGoogle(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ url: string }> {
    if (!this.google.enabled) throw new NotFoundException();
    const tokenHash = this.tokens.hash(token(body));
    const info = await this.members.inspect(tokenHash);
    if (!info || !info.open || !info.tenantActive) throw new BadRequestException(INVALID_LINK);
    const start = await this.google.start();
    const cookie = await this.tokens.signState({ state: start.state, nonce: start.nonce, verifier: start.verifier, tenant: info.tenantSlug, invite: tokenHash }, OIDC_STATE_TTL_MS);
    setCookie(res, 'oidcState', cookie, this.sessions.secure, OIDC_STATE_TTL_MS);
    return { url: start.url };
  }
}
