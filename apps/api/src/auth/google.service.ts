import { Injectable, Logger } from '@nestjs/common';
import * as oidc from 'openid-client';
import { originFor, parseEnvironment, type GoogleConfig } from '../config/environment.js';
import { AuthStore, type LoginUser } from '../database/auth-store.service.js';

export interface GoogleStart { url: string; state: string; nonce: string; verifier: string }

/**
 * Вход через Google по OpenID Connect (подшаг 3.9, A12).
 * openid-client выполняет discovery, PKCE, проверку state, nonce, подписи и срока ID-токена.
 * Регистрации нет: Google-аккаунт связывается только с существующим пользователем —
 * по постоянному идентификатору sub или, при первой привязке, по email с email_verified=true.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger('GoogleAuth');
  private readonly google: GoogleConfig | undefined;
  private readonly redirectUri: string;
  private config: Promise<oidc.Configuration> | undefined;

  constructor(private readonly store: AuthStore) {
    const env = parseEnvironment(process.env);
    this.google = env.google;
    this.redirectUri = originFor(env, 'app') + '/api/auth/google/callback';
  }

  get enabled(): boolean { return this.google !== undefined; }
  get callbackUrl(): string { return this.redirectUri; }

  private configuration(): Promise<oidc.Configuration> {
    const google = this.google as GoogleConfig;
    this.config ??= oidc.discovery(new URL(google.issuer), google.clientId, google.clientSecret, undefined,
      // http разрешён конфигурацией только локально (поддельный провайдер в тестах).
      google.issuer.startsWith('http:') ? { execute: [oidc.allowInsecureRequests] } : undefined,
    ).catch((error: unknown) => { this.config = undefined; throw error; });
    return this.config;
  }

  async start(): Promise<GoogleStart> {
    const config = await this.configuration();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri, scope: 'openid email profile', response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      state, nonce, prompt: 'select_account',
    });
    return { url: url.href, state, nonce, verifier };
  }

  /** Проверенные openid-client данные Google-аккаунта или null. */
  async verify(query: string, checks: { state: string; nonce: string; verifier: string }): Promise<GoogleClaims | null> {
    let claims: oidc.IDToken | undefined;
    try {
      const config = await this.configuration();
      const tokens = await oidc.authorizationCodeGrant(config, new URL(this.redirectUri + '?' + query), {
        expectedState: checks.state, expectedNonce: checks.nonce, pkceCodeVerifier: checks.verifier, idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      this.logger.warn(`Google sign-in rejected: ${(error as { code?: string }).code ?? (error as Error).name}`);
      return null;
    }
    if (!claims || typeof claims.sub !== 'string') return null;
    return {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null,
      emailVerified: claims.email_verified === true,
    };
  }

  /**
   * Существующий аккаунт для Google-входа или null (регистрации нет, A12): по sub или, при первой привязке,
   * по подтверждённому email, совпадающему с аккаунтом.
   */
  async resolveUser(claims: GoogleClaims): Promise<LoginUser | null> {
    const linked = await this.store.findUserByGoogleSubject(claims.sub);
    if (linked) return linked.isActive ? linked : null;
    if (!claims.emailVerified || !claims.email) return null;
    const user = await this.store.findUserByEmail(claims.email);
    if (!user || !user.isActive) return null;
    if (!(await this.store.linkGoogle(user.id, claims.sub, claims.email))) return null; // у аккаунта уже другой Google
    return user;
  }

  /** Вход обычным способом: verify + resolveUser. */
  async finish(query: string, checks: { state: string; nonce: string; verifier: string }): Promise<LoginUser | null> {
    const claims = await this.verify(query, checks);
    return claims ? this.resolveUser(claims) : null;
  }
}

export interface GoogleClaims { sub: string; email: string | null; emailVerified: boolean }
