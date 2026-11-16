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

/**
 * C3: первый администратор получает приглашение по email (участником он станет, когда примет его).
 * invitationSent=false — письмо не ушло (почта не настроена или сбой); можно отправить повторно из карточки.
 */
export interface CreateTenantResponse {
  tenant: PlatformTenant;
  firstAdmin: { email: string; name: string };
  invitationSent: boolean;
}

/** POST /api/platform/tenants/:id/admin-invitations — приглашение администратора компании (C3, C4). */
export interface AdminInvitationRequest { email: string; name: string }
export interface InvitationSentResponse { invitationSent: boolean }

// ───────────── Phase 5: участники компании ─────────────

export interface MemberEntry { userId: string; name: string; email: string; role: TenantRole; isActive: boolean; isSelf: boolean }
export interface PendingInvitation { id: string; email: string; name: string; role: TenantRole; expiresAt: string; createdAt: string; expired: boolean }
/** GET /api/members — только для администратора компании. Без паролей, сессий и способов входа. */
export interface MembersResponse { members: MemberEntry[]; invitations: PendingInvitation[] }
export interface InviteMemberRequest { email: string; name: string; role: TenantRole }
export interface UpdateMemberRequest { role?: TenantRole; isActive?: boolean }

/** POST /api/invitations/inspect — что видит человек по ссылке из письма. */
export interface InvitationInspectResponse {
  companyName: string; email: string; name: string; role: TenantRole;
  /** used — ссылка уже использована, отозвана или истекла. */
  status: 'open' | 'used';
  /** Есть ли аккаунт с этим email — знает только владелец ссылки (то есть сам приглашённый). */
  accountExists: boolean;
  /** Email, под которым браузер вошёл на app.<домен>, или null. */
  signedInAs: string | null;
  google: boolean;
}
/** POST /api/invitations/accept: для нового аккаунта — name и password; для существующего — вход заранее. */
export interface InvitationAcceptRequest { token: string; name?: string; password?: string }
export interface InvitationAcceptResponse { tenantSlug: string }

/** Восстановление пароля (5.6). Ответ на запрос всегда одинаковый. */
export interface PasswordResetRequest { email: string }
export interface PasswordResetConfirmRequest { token: string; newPassword: string }

/** slug не меняется (B4). */
export interface UpdateTenantRequest { name?: string; displayName?: string; status?: TenantStatus }

/** GET /api/auth/providers — доступные способы входа. */
export interface AuthProvidersResponse { password: true; google: boolean }

/** Ошибка API: только сообщение для пользователя, без внутренних деталей. */
export interface ApiError { statusCode: number; message: string | string[] }
