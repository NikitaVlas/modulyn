import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { parseEnvironment } from '../config/environment.js';
import type { ContextKind } from '../tenancy/request-context.js';
import { ACCESS_TTL_MS, CLOCK_TOLERANCE_S } from './auth.constants.js';

export interface AccessClaims { sub: string; sid: string; tid?: string }

const ISSUER = 'modulyn';

/**
 * Токены (A3).
 * Access JWT подписывается отдельным ключом для каждого контекста (tenant / app / platform) и содержит aud.
 * Поэтому токен платформы не пройдёт проверку подписи на поддомене компании, даже если ошибиться в проверке aud.
 * Refresh-токены, коды перехода и state — случайные 256-битные строки; в БД хранится только SHA-256.
 */
@Injectable()
export class TokensService {
  private readonly keys: Record<ContextKind, Uint8Array>;
  private readonly hmacKey: Buffer;
  private readonly stateKey: Uint8Array;

  constructor() {
    const env = parseEnvironment(process.env);
    const encode = (value: string) => new TextEncoder().encode(value);
    this.keys = { tenant: encode(env.jwtSecrets.tenant), app: encode(env.jwtSecrets.app), platform: encode(env.jwtSecrets.platform) };
    // Производные ключи для других целей: один секрет не используется для двух разных подписей.
    this.hmacKey = createHmac('sha256', env.jwtSecrets.app).update('throttle-keys').digest();
    this.stateKey = createHmac('sha256', env.jwtSecrets.app).update('oidc-state').digest();
  }

  signAccess(kind: ContextKind, claims: AccessClaims): Promise<string> {
    const jwt = new SignJWT({ sid: claims.sid, ...(claims.tid ? { tid: claims.tid } : {}) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER).setAudience(kind).setSubject(claims.sub)
      .setIssuedAt().setExpirationTime(Math.floor((Date.now() + ACCESS_TTL_MS[kind]) / 1000));
    return jwt.sign(this.keys[kind]);
  }

  /** null при любой ошибке: подпись, aud, iss, срок, формат. Причина наружу не сообщается. */
  async verifyAccess(kind: ContextKind, token: string | undefined): Promise<AccessClaims | null> {
    if (!token || token.length > 2048) return null;
    try {
      const { payload } = await jwtVerify(token, this.keys[kind], {
        issuer: ISSUER, audience: kind, algorithms: ['HS256'], clockTolerance: CLOCK_TOLERANCE_S,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      if (kind === 'tenant' && typeof payload.tid !== 'string') return null;
      return { sub: payload.sub, sid: payload.sid, ...(typeof payload.tid === 'string' ? { tid: payload.tid } : {}) };
    } catch { return null; }
  }

  randomToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Ключ счётчика ограничения входа: HMAC, чтобы в БД не лежали IP и email в открытом виде. */
  throttleKey(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }

  /** Подписанное короткоживущее состояние (Google-вход) для HttpOnly cookie. */
  signState(payload: Record<string, string>, ttlMs: number): Promise<string> {
    return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience('oidc-state')
      .setExpirationTime(Math.floor((Date.now() + ttlMs) / 1000)).sign(this.stateKey);
  }

  async verifyState(token: string | undefined): Promise<Record<string, unknown> | null> {
    if (!token || token.length > 4096) return null;
    try {
      return (await jwtVerify(token, this.stateKey, { issuer: ISSUER, audience: 'oidc-state', algorithms: ['HS256'] })).payload;
    } catch { return null; }
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
