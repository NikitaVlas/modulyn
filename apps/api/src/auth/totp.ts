import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Второй фактор TOTP (RFC 6238, B2) на node:crypto — без дополнительной зависимости.
 * Параметры, которые понимают все приложения-аутентификаторы: HMAC-SHA1, 6 цифр, шаг 30 секунд.
 * Принимается код текущего шага и соседних (±1) — на случай небольшого расхождения часов.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_S = 30;
const DIGITS = 6;

export function base32Encode(data: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of data) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0; let value = 0; const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160-битный секрет — рекомендация RFC 4226 для HMAC-SHA1. */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, '0');
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/**
 * Номер шага, которому соответствует код, или null.
 * Шаги не позже lastStep отклоняются: один и тот же код нельзя использовать дважды (перехват и повтор).
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number | null, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUri(secret: Buffer, account: string, issuer = 'Modulyn'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Шифрование секрета TOTP в БД (AES-256-GCM, ключ PLATFORM_TOTP_KEY из окружения).
 * Формат: base64(iv[12] | tag[16] | ciphertext). Без ключа из БД секрет не восстановить.
 */
export function sealSecret(key: Buffer, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openSecret(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

/** Коды восстановления: 10 штук вида XXXXX-XXXXX (base32 без похожих символов не требуется — вводятся копированием). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const text = base32Encode(randomBytes(7)).slice(0, 10);
    return `${text.slice(0, 5)}-${text.slice(5)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
