/** Сроки жизни (A4, specs/phase3_design.md, раздел 3.2). */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ACCESS_TTL_MS = { tenant: 10 * MINUTE, app: 10 * MINUTE, platform: 5 * MINUTE } as const;
export const REFRESH_IDLE_MS = { tenant: 7 * DAY, app: 7 * DAY, platform: 2 * HOUR } as const;
export const REFRESH_ABSOLUTE_MS = { tenant: 30 * DAY, app: 30 * DAY, platform: 12 * HOUR } as const;
export const HANDOFF_CODE_TTL_MS = 60_000;
export const HANDOFF_STATE_TTL_MS = 5 * MINUTE;
export const OIDC_STATE_TTL_MS = 10 * MINUTE;
/** Окно, в котором повтор уже обменянного refresh-токена считается одновременным запросом, а не кражей. */
export const ROTATION_GRACE_MS = 20_000;
/** Допуск расхождения часов при проверке JWT. */
export const CLOCK_TOLERANCE_S = 30;

/** Ограничение входа (A9). */
export const THROTTLE_WINDOW_MS = 15 * MINUTE;
export const THROTTLE_MAX_PER_IP = 20;
export const THROTTLE_MAX_FAILED_PER_EMAIL = 10;

/** Политика паролей (A8). */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
