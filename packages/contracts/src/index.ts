/** Public API responses only. No database entities, hashes, tokens or secrets. */
export interface HealthResponse { status: 'ok'; service: 'modulyn-api' }
export interface ReadinessResponse { status: 'ready'; database: 'up' }
/** GET /api/tenant — публичные данные компании текущего поддомена. */
export interface TenantInfoResponse { slug: string; displayName: string }

// ───────────── Phase 3: вход и сессии ─────────────

export type TenantRole = 'TENANT_ADMIN' | 'MANAGER';

export interface AccountInfo { name: string; email: string }

/** POST /api/auth/login (app.<домен>, admin.<домен>). */
export interface LoginRequest { email: string; password: string }

/** POST /api/auth/password — смена своего пароля. */
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }

export interface CompanyEntry { slug: string; displayName: string; role: TenantRole }

/** GET /api/auth/me на app.<домен>: аккаунт и только активные участия в активных компаниях. */
export interface AppMeResponse { user: AccountInfo; companies: CompanyEntry[] }

/** GET /api/auth/me на поддомене компании. Роль — актуальная из БД. */
export interface TenantMeResponse { user: AccountInfo; role: TenantRole; tenant: TenantInfoResponse }

/** GET /api/auth/me на admin.<домен>. */
export interface PlatformMeResponse { admin: AccountInfo }

/** GET /api/auth/providers — доступные способы входа. */
export interface AuthProvidersResponse { password: true; google: boolean }

/** Ошибка API: только сообщение для пользователя, без внутренних деталей. */
export interface ApiError { statusCode: number; message: string | string[] }
