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

/** POST /api/auth/login: на admin.<домен> с включённым вторым фактором — mfaRequired, сессии ещё нет. */
export interface LoginResponse { ok: true; mfaRequired?: true }

/** GET /api/auth/me на app.<домен>: аккаунт и только активные участия в активных компаниях. */
export interface AppMeResponse { user: AccountInfo; companies: CompanyEntry[]; passwordChangeRequired: boolean }

/** GET /api/auth/me на поддомене компании. Роль — актуальная из БД. */
export interface TenantMeResponse { user: AccountInfo; role: TenantRole; tenant: TenantInfoResponse; passwordChangeRequired: boolean }

/** GET /api/auth/me на admin.<домен>. До смены временного пароля и настройки второго фактора доступ ограничен. */
export interface PlatformMeResponse { admin: AccountInfo; passwordChangeRequired: boolean; mfaSetupRequired: boolean }

/** POST /api/auth/mfa/setup — секрет показывается один раз для приложения-аутентификатора. */
export interface MfaSetupResponse { otpauthUri: string; secret: string }
/** POST /api/auth/mfa/enable — коды восстановления показываются один раз. */
export interface MfaEnableResponse { recoveryCodes: string[] }
/** POST /api/auth/mfa — второй шаг входа: 6-значный код или код восстановления. */
export interface MfaVerifyRequest { code: string }

// ───────────── Phase 4: компании на платформе ─────────────

export type TenantStatus = 'ACTIVE' | 'SUSPENDED';

/** Компания глазами администратора платформы: без лидов, имён и email участников (B6). */
export interface PlatformTenant {
  id: string; slug: string; name: string; displayName: string; status: TenantStatus;
  activeMembers: number; createdAt: string; updatedAt: string;
}

export interface CreateTenantRequest { slug: string; name: string; displayName: string; adminEmail: string; adminName: string }

/** temporaryPassword — только если для первого администратора создан новый аккаунт; показывается один раз. */
export interface CreateTenantResponse {
  tenant: PlatformTenant;
  firstAdmin: { email: string; name: string; existingAccount: boolean };
  temporaryPassword?: string;
}

/** slug не меняется (B4). */
export interface UpdateTenantRequest { name?: string; displayName?: string; status?: TenantStatus }

/** GET /api/auth/providers — доступные способы входа. */
export interface AuthProvidersResponse { password: true; google: boolean }

/** Ошибка API: только сообщение для пользователя, без внутренних деталей. */
export interface ApiError { statusCode: number; message: string | string[] }
