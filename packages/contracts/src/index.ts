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
/** Phase 10: язык интерфейса (немецкий по умолчанию). Совпадает с Locale из @modulyn/i18n. */
export type UiLocale = 'de' | 'en' | 'ru';

export interface AppMeResponse { user: AccountInfo; companies: CompanyEntry[]; passwordChangeRequired: boolean; locale: UiLocale }

/** GET /api/auth/me на поддомене компании. Роль — актуальная из БД. */
export interface TenantMeResponse { user: AccountInfo; role: TenantRole; tenant: TenantInfoResponse; passwordChangeRequired: boolean; locale: UiLocale }

/** GET /api/auth/me на admin.<домен>. До смены временного пароля и настройки второго фактора доступ ограничен. */
export interface PlatformMeResponse { admin: AccountInfo; passwordChangeRequired: boolean; mfaSetupRequired: boolean; locale: UiLocale }

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
  /** Phase 10 (I4): язык приглашения (пригласившего) — страница открывается на нём. */
  locale: UiLocale;
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

// ───────────── Phase 6: модули ─────────────

/** Ключи модулей из реестра кода (apps/api/src/modules/registry.ts). */
export type ModuleKey = 'leads';
export type LeadStatus = 'NEW' | 'IN_PROGRESS' | 'CONTACTED' | 'CONVERTED' | 'CLOSED';

/** GET /api/tenant/capabilities — включённые модули компании и роль (для меню). */
export interface TenantCapabilitiesResponse { modules: ModuleKey[]; role: TenantRole }

/** Модуль в карточке компании на платформе. */
export interface PlatformTenantModule { key: ModuleKey; name: string; description: string; enabled: boolean }
export interface SetTenantModuleRequest { enabled: boolean }

/** GET /api/leads/summary — заявки компании по статусам (модуль «Заявки»). */
export interface LeadsSummaryResponse { total: number; byStatus: Record<LeadStatus, number> }

// ───────────── Phase 7: заявки ─────────────

export type LeadSource = 'WEB_FORM' | 'MANUAL';
export type LeadSort = 'created_desc' | 'created_asc';
export interface PersonRef { userId: string; name: string }

/** Строка списка (L8): без текста сообщения. */
export interface LeadListItem {
  id: string; name: string; email: string | null; phone: string | null;
  source: LeadSource; sourceDetail: string | null; status: LeadStatus;
  assignee: PersonRef | null; createdAt: string;
}

/** GET /api/leads — страница списка (L2). */
export interface LeadListResponse { items: LeadListItem[]; total: number; page: number; pageSize: number }

export interface LeadHistoryEntry { id: string; previousStatus: LeadStatus | null; newStatus: LeadStatus; changedBy: PersonRef | null; createdAt: string }

/** GET /api/leads/:id — карточка с историей статусов. */
export interface LeadDetail extends LeadListItem { message: string | null; updatedAt: string; history: LeadHistoryEntry[] }

/** POST /api/leads — ручная заявка (L4): имя и хотя бы один контакт. */
export interface CreateLeadRequest { name: string; email?: string; phone?: string; message?: string }

/** POST /api/leads/:id/status — from: статус, который видел пользователь (L3). */
export interface ChangeLeadStatusRequest { from: LeadStatus; to: LeadStatus }

/** PUT /api/leads/:id/assignee — только администратор компании (L5). */
export interface AssignLeadRequest { userId: string | null }

/** GET /api/leads/assignees — активные участники компании для фильтра и назначения. */
export interface LeadAssignee { userId: string; name: string; role: TenantRole }

// ───────────── Phase 8: приём заявок с сайтов ─────────────

export type FormEndpointMode = 'SERVER' | 'BROWSER';
export type FormSubmissionStatus = 'IMPORTED' | 'DUPLICATE' | 'REJECTED';

/** W4: переименования полей формы и дополнительные поля, добавляемые в сообщение. */
export interface FormFieldMapping {
  fields?: Partial<Record<'name' | 'firstName' | 'lastName' | 'email' | 'phone' | 'message', string>>;
  extra?: { field: string; label: string }[];
}

/** Точка приёма в разделе «Приём заявок». Секрета нет — он показывается один раз. */
export interface FormEndpointInfo {
  id: string; name: string; mode: FormEndpointMode; publicKey: string; intakeUrl: string;
  secretPrefix: string | null; allowedOrigins: string[]; sourceDetail: string | null;
  fieldMapping: FormFieldMapping | null; isActive: boolean; lastUsedAt: string | null; createdAt: string;
}

export interface CreateFormEndpointRequest {
  name: string; mode: FormEndpointMode; sourceDetail?: string | null;
  allowedOrigins?: string[]; fieldMapping?: FormFieldMapping | null;
}
export interface UpdateFormEndpointRequest {
  name?: string; sourceDetail?: string | null; allowedOrigins?: string[]; fieldMapping?: FormFieldMapping | null; isActive?: boolean;
}
/** Ответ на создание SERVER-точки и перевыпуск секрета: secret показывается только здесь. */
export interface FormEndpointCreatedResponse { endpoint: FormEndpointInfo; secret: string | null }
export interface FormSecretResponse { secret: string }

/** Запись журнала приёма (W7): без содержимого формы. */
export interface FormSubmissionEntry {
  id: string; endpointId: string; endpointName: string; status: FormSubmissionStatus;
  errorCode: string | null; leadId: string | null; createdAt: string;
}
