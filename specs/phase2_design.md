# Phase 2 — Multi-Tenant Foundation: план и схема

Источник требований, одобрений и статусов: [SPEC](../SPEC.md).
Статус документа: **редакция 2, согласована** (2026-11-16; Phase 2 одобрена «подтверждаю / начинай реализацию phase 2»). Решения D1′–D11 согласованы (раздел 6). Реализация — раздел 8 и отчёт в SPEC.

## 1. Цель и границы

Цель Phase 2 — фундамент изоляции: согласованная модель данных, миграции, определение компании по hostname, tenant context в NestJS и PostgreSQL RLS. Результат проверяется тестами на двух синтетических компаниях и пользователе, который состоит в обеих.

Входит в Phase 2:

- Prisma, схема и миграции для таблиц этапа (D4, раздел 2.4).
- Разделение ролей БД: владелец схемы и миграций отдельно от runtime-роли без обхода RLS.
- Разбор hostname, справочник зарезервированных имён, поиск компании, безопасный отказ.
- AsyncLocalStorage tenant context, tenant-scoped доступ к БД, запрет запросов без контекста.
- RLS-политики, транзакционная установка контекста, проверка пула соединений.
- Синтетические fixtures `nova`, `company-b`, `suspended-co`, интеграционные тесты изоляции.
- Обновление README, `.env.example`, Compose и SPEC.

Не входит (последующие фазы): вход по паролю и через Google, сессии, выбор компании, RBAC (Phase 3); CRUD компаний и админ-интерфейс (Phase 4); приглашения и управление участниками (Phase 5); guard модулей (Phase 6); API и UI лидов (Phase 7); приём заявок с сайта (Phase 8); production DNS/TLS. Frontend в Phase 2 не меняется.

## 2. Модель данных

### 2.1 Главная идея

- **User** — человек. Один аккаунт на всю систему: один email, один пароль и/или привязанный Google.
- **Membership** — участие человека в компании с ролью (TENANT_ADMIN или MANAGER). Один User может иметь несколько Membership — например, менеджер в Nova и в Company B.
- **PlatformAdmin** — отдельная таблица владельцев платформы, вне компаний (D2).
- Все данные компании (лиды, история, аудит, сессии, участие, модули, формы) несут `tenant_id` и защищены RLS.
- Ссылка «какой пользователь» внутри компании идёт парой `(tenant_id, user_id)` на `memberships`. Это одновременно гарантирует, что пользователь существует **и** состоит именно в этой компании. Назначить лид человеку не из компании невозможно на уровне PostgreSQL.

### 2.2 Prisma schema

Синтаксис ориентирован на Prisma 7 (generator `prisma-client`, URL в `prisma.config.ts`, драйвер `@prisma/adapter-pg`). Стабильная версия и синтаксис проверяются в 2.2 (D7).

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  // URL в prisma.config.ts: MIGRATION_DATABASE_URL для migrate, DATABASE_URL для runtime.
}

// ───────────── Справочники ─────────────

enum TenantStatus {
  ACTIVE
  SUSPENDED
}

enum MembershipRole {
  TENANT_ADMIN
  MANAGER
}

enum IdentityProvider {
  GOOGLE
}

enum LeadStatus {
  NEW
  IN_PROGRESS
  CONTACTED
  CONVERTED
  CLOSED
}

enum LeadSource {
  WEB_FORM
  MANUAL
}

enum FormEndpointMode {
  SERVER
  BROWSER
}

enum FormSubmissionStatus {
  IMPORTED
  DUPLICATE
  REJECTED
}

// ═════════════ Глобальные таблицы (без tenant_id, без RLS) ═════════════

model Tenant {
  id          String       @id @default(uuid(7)) @db.Uuid
  slug        String       @unique @db.VarChar(63)
  name        String       @db.VarChar(200)
  displayName String       @map("display_name") @db.VarChar(200)
  status      TenantStatus @default(ACTIVE)
  createdAt   DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime     @updatedAt @map("updated_at") @db.Timestamptz(3)

  memberships       Membership[]
  modules           TenantModule[]
  leads             Lead[]
  leadStatusHistory LeadStatusHistory[]
  sessions          TenantSession[]
  loginHandoffs     LoginHandoff[]
  formEndpoints     FormEndpoint[]
  formSubmissions   FormSubmission[]
  auditLogs         TenantAuditLog[]
  platformAuditLogs PlatformAuditLog[]

  @@map("tenants")
}

/// Человек. Один аккаунт на все компании.
model User {
  id              String    @id @default(uuid(7)) @db.Uuid
  email           String    @unique @db.VarChar(320) // trim + lower-case
  emailVerifiedAt DateTime? @map("email_verified_at") @db.Timestamptz(3)
  passwordHash    String?   @map("password_hash") // null: пароль не задан (только Google или приглашение не принято)
  name            String    @db.VarChar(200)
  isActive        Boolean   @default(true) @map("is_active") // блокировка всего аккаунта платформой
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  memberships   Membership[]
  identities    UserIdentity[]
  sessions      UserSession[]
  loginHandoffs LoginHandoff[]

  @@map("users")
}

/// Внешний способ входа (Google). Связывает аккаунт Google с User.
model UserIdentity {
  id              String           @id @default(uuid(7)) @db.Uuid
  userId          String           @map("user_id") @db.Uuid
  provider        IdentityProvider
  providerSubject String           @map("provider_subject") @db.VarChar(255) // claim "sub" — постоянный id в Google
  emailAtLink     String           @map("email_at_link") @db.VarChar(320)
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  lastUsedAt      DateTime?        @map("last_used_at") @db.Timestamptz(3)

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@unique([provider, providerSubject])
  @@unique([userId, provider]) // не более одного Google на аккаунт
  @@map("user_identities")
}

/// Сессия центрального входа (app.<домен>): список компаний и выбор.
model UserSession {
  id         String    @id @default(uuid(7)) @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  tokenHash  String    @unique @map("token_hash") @db.VarChar(128)
  familyId   String    @map("family_id") @db.Uuid
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz(3)
  rotatedAt  DateTime? @map("rotated_at") @db.Timestamptz(3)
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz(3)

  user User @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([userId])
  @@index([familyId])
  @@map("user_sessions")
}

/// Одноразовый код перехода с app.<домен> на поддомен компании (секунды жизни).
model LoginHandoff {
  id        String    @id @default(uuid(7)) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  tenantId  String    @map("tenant_id") @db.Uuid
  codeHash  String    @unique @map("code_hash") @db.VarChar(128)
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(3)
  usedAt    DateTime? @map("used_at") @db.Timestamptz(3)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  user   User   @relation(fields: [userId], references: [id], onDelete: Restrict)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@index([expiresAt])
  @@map("login_handoffs")
}

model PlatformAdmin {
  id           String   @id @default(uuid(7)) @db.Uuid
  email        String   @unique @db.VarChar(320)
  passwordHash String   @map("password_hash")
  name         String   @db.VarChar(200)
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  sessions  PlatformSession[]
  auditLogs PlatformAuditLog[]

  @@map("platform_admins")
}

model PlatformSession {
  id         String    @id @default(uuid(7)) @db.Uuid
  adminId    String    @map("admin_id") @db.Uuid
  tokenHash  String    @unique @map("token_hash") @db.VarChar(128)
  familyId   String    @map("family_id") @db.Uuid
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz(3)
  rotatedAt  DateTime? @map("rotated_at") @db.Timestamptz(3)
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz(3)

  admin PlatformAdmin @relation(fields: [adminId], references: [id], onDelete: Restrict)

  @@index([adminId])
  @@index([familyId])
  @@map("platform_sessions")
}

model PlatformAuditLog {
  id             String   @id @default(uuid(7)) @db.Uuid
  actorAdminId   String?  @map("actor_admin_id") @db.Uuid
  targetTenantId String?  @map("target_tenant_id") @db.Uuid
  action         String   @db.VarChar(100)
  metadata       Json?    @db.JsonB // без секретов и персональных данных
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  actor        PlatformAdmin? @relation(fields: [actorAdminId], references: [id], onDelete: Restrict)
  targetTenant Tenant?        @relation(fields: [targetTenantId], references: [id], onDelete: Restrict)

  @@index([createdAt])
  @@index([targetTenantId, createdAt])
  @@map("platform_audit_logs")
}

model Module {
  id          String   @id @default(uuid(7)) @db.Uuid
  key         String   @unique @db.VarChar(64) // ключ статического реестра кода, например "leads"
  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  tenants TenantModule[]

  @@map("modules")
}

// ═════════════ Данные компаний (tenant_id + RLS) ═════════════

/// Участие пользователя в компании.
model Membership {
  id        String         @id @default(uuid(7)) @db.Uuid
  tenantId  String         @map("tenant_id") @db.Uuid
  userId    String         @map("user_id") @db.Uuid
  role      MembershipRole
  isActive  Boolean        @default(true) @map("is_active") // отключение в этой компании, аккаунт остаётся
  createdAt DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant        Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  user          User                @relation(fields: [userId], references: [id], onDelete: Restrict)
  assignedLeads Lead[]              @relation("LeadAssignee")
  statusChanges LeadStatusHistory[]
  sessions      TenantSession[]
  auditLogs     TenantAuditLog[]

  @@unique([tenantId, userId]) // цель составных FK; одно участие на компанию
  @@index([userId])
  @@map("memberships")
}

model TenantModule {
  tenantId  String   @map("tenant_id") @db.Uuid
  moduleId  String   @map("module_id") @db.Uuid
  enabled   Boolean  @default(false)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  module Module @relation(fields: [moduleId], references: [id], onDelete: Restrict)

  @@id([tenantId, moduleId])
  @@map("tenant_modules")
}

/// Сессия внутри компании (поддомен). Действует только для своей компании.
model TenantSession {
  id         String    @id @default(uuid(7)) @db.Uuid
  tenantId   String    @map("tenant_id") @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  tokenHash  String    @unique @map("token_hash") @db.VarChar(128)
  familyId   String    @map("family_id") @db.Uuid
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz(3)
  rotatedAt  DateTime? @map("rotated_at") @db.Timestamptz(3)
  revokedAt  DateTime? @map("revoked_at") @db.Timestamptz(3)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  lastUsedAt DateTime? @map("last_used_at") @db.Timestamptz(3)

  tenant     Tenant     @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  membership Membership @relation(fields: [tenantId, userId], references: [tenantId, userId], onDelete: Restrict)

  @@index([tenantId, userId])
  @@index([familyId])
  @@map("tenant_sessions")
}

model Lead {
  id           String     @id @default(uuid(7)) @db.Uuid
  tenantId     String     @map("tenant_id") @db.Uuid
  name         String     @db.VarChar(200)
  email        String?    @db.VarChar(320)
  phone        String?    @db.VarChar(50)
  message      String?    @db.Text
  source       LeadSource
  sourceDetail String?    @map("source_detail") @db.VarChar(100) // например "trial" / "contact" — какая форма сайта
  status       LeadStatus @default(NEW)
  assignedToId String?    @map("assigned_to_id") @db.Uuid // users.id; FK через memberships
  createdAt    DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant          Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  assignee        Membership?         @relation("LeadAssignee", fields: [tenantId, assignedToId], references: [tenantId, userId], onDelete: Restrict)
  statusHistory   LeadStatusHistory[]
  formSubmissions FormSubmission[]

  @@unique([tenantId, id])
  @@index([tenantId, createdAt(sort: Desc)])
  @@index([tenantId, status, createdAt(sort: Desc)])
  @@index([tenantId, assignedToId])
  @@map("leads")
}

model LeadStatusHistory {
  id             String      @id @default(uuid(7)) @db.Uuid
  tenantId       String      @map("tenant_id") @db.Uuid
  leadId         String      @map("lead_id") @db.Uuid
  previousStatus LeadStatus? @map("previous_status") // null — создание лида
  newStatus      LeadStatus  @map("new_status")
  changedById    String?     @map("changed_by_id") @db.Uuid // null — системное действие (приём с сайта)
  createdAt      DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant    Tenant      @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  lead      Lead        @relation(fields: [tenantId, leadId], references: [tenantId, id], onDelete: Restrict)
  changedBy Membership? @relation(fields: [tenantId, changedById], references: [tenantId, userId], onDelete: Restrict)

  @@index([tenantId, leadId, createdAt])
  @@map("lead_status_history")
}

/// Точка приёма заявок от любого внешнего источника компании (сайт на любой технологии и хостинге).
/// SERVER: отправитель — сервер, аутентификация секретом (в БД только хеш).
/// BROWSER: отправитель — браузер посетителя; публичный ключ + разрешённые origin, лимиты, антиспам.
model FormEndpoint {
  id             String             @id @default(uuid(7)) @db.Uuid
  tenantId       String             @map("tenant_id") @db.Uuid
  name           String             @db.VarChar(100) // например "Сайт bjjmoenchengladbach.de"
  mode           FormEndpointMode
  publicKey      String             @unique @map("public_key") @db.VarChar(64) // идентификатор точки, не секрет
  secretPrefix   String?            @map("secret_prefix") @db.VarChar(12)  // только SERVER: для показа в интерфейсе
  secretHash     String?            @map("secret_hash") @db.VarChar(128)   // только SERVER
  allowedOrigins String[]           @map("allowed_origins")                // только BROWSER, например https://bjjmoenchengladbach.de
  fieldMapping   Json?              @map("field_mapping") @db.JsonB        // имена полей формы → поля Lead, если не по стандартному контракту
  isActive       Boolean            @default(true) @map("is_active")
  lastUsedAt     DateTime?          @map("last_used_at") @db.Timestamptz(3)
  createdAt      DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime           @updatedAt @map("updated_at") @db.Timestamptz(3)

  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  submissions FormSubmission[]

  @@unique([tenantId, id])
  @@map("form_endpoints")
}

/// Журнал приёма заявок: дедупликация и диагностика. Содержимое формы здесь не хранится.
model FormSubmission {
  id             String               @id @default(uuid(7)) @db.Uuid
  tenantId       String               @map("tenant_id") @db.Uuid
  endpointId     String               @map("endpoint_id") @db.Uuid
  idempotencyKey String               @map("idempotency_key") @db.VarChar(128) // id отправки с сайта или хеш тела
  status         FormSubmissionStatus
  errorCode      String?              @map("error_code") @db.VarChar(100)
  leadId         String?              @map("lead_id") @db.Uuid
  createdAt      DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant   Tenant       @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  endpoint FormEndpoint @relation(fields: [tenantId, endpointId], references: [tenantId, id], onDelete: Restrict)
  lead     Lead?        @relation(fields: [tenantId, leadId], references: [tenantId, id], onDelete: Restrict)

  @@unique([tenantId, endpointId, idempotencyKey])
  @@index([tenantId, createdAt])
  @@map("form_submissions")
}

model TenantAuditLog {
  id          String   @id @default(uuid(7)) @db.Uuid
  tenantId    String   @map("tenant_id") @db.Uuid
  actorUserId String?  @map("actor_user_id") @db.Uuid
  action      String   @db.VarChar(100) // например membership.created, lead.assigned
  entityType  String?  @map("entity_type") @db.VarChar(50)
  entityId    String?  @map("entity_id") @db.Uuid
  metadata    Json?    @db.JsonB // без секретов и содержимого заявок
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  tenant Tenant      @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  actor  Membership? @relation(fields: [tenantId, actorUserId], references: [tenantId, userId], onDelete: Restrict)

  @@index([tenantId, createdAt])
  @@map("tenant_audit_logs")
}
```

### 2.3 Связи и почему так

- **Человек и компании.** `users` — кто человек и как он входит. `memberships` — где и в какой роли он работает. Администратор компании управляет только `memberships` своей компании: может отключить участие, но не может менять пароль или Google-привязку человека.
- **Составные FK на `memberships (tenant_id, user_id)`** из `leads.assigned_to_id`, `lead_status_history.changed_by_id`, `tenant_audit_logs.actor_user_id`, `tenant_sessions.user_id`. Ссылка возможна, только если человек участвует именно в этой компании.
- **Две ступени сессии.** `user_sessions` — центральный вход на `app.<домен>`: человек видит свои компании. Выбор компании создаёт `login_handoffs` — одноразовый код на несколько секунд. Поддомен компании обменивает код на `tenant_sessions`. Cookies остаются привязанными к своему хосту (без `Domain`), и сессия Nova не работает на поддомене Company B. Детали — Phase 3.
- **Google.** `user_identities` связывает постоянный Google `sub` с аккаунтом. Публичной регистрации нет: войти через Google может только человек, у которого уже есть аккаунт или приглашение. Первая привязка — только при подтверждённом Google email (`email_verified`), совпадающем с email аккаунта.
- **Заявки с сайтов (D11).** Механизм не зависит от технологии и хостинга сайта: CRM даёт каждой компании одну или несколько точек приёма (`form_endpoints`) с документированным HTTP-контрактом. Сайт с серверной частью (PHP, Node, функция хостинга) использует режим SERVER с секретом; сайт без серверной части (статический React и т.п.) — режим BROWSER с публичным ключом, списком разрешённых origin, лимитами и антиспамом. Если поля формы называются иначе, используется `fieldMapping`. `form_submissions` — журнал приёма: повтор той же отправки не создаёт второй лид. Данные формы попадают только в `leads`; копия тела запроса не хранится. Письмо на почту, если сайт его отправляет, продолжает приходить как резервная копия.
- **Удаления.** Везде `onDelete: Restrict`. Компании, аккаунты и участия отключаются флагами, история сохраняется. Физическое удаление и сроки хранения — 9.5 (GDPR).
- **IMAP.** Таблицы почтовой интеграции убраны из схемы (D6). Если чтение почты понадобится позже, добавим отдельной миграцией и значением `EMAIL` в `LeadSource`.

### 2.4 Какие таблицы мигрируются когда (D4)

| Миграция | Таблицы |
| --- | --- |
| Phase 2 | tenants, users, memberships, platform_admins, modules, tenant_modules, leads, lead_status_history, tenant_audit_logs, platform_audit_logs |
| Phase 3 | user_identities, user_sessions, login_handoffs, tenant_sessions, platform_sessions |
| Phase 8 | form_endpoints, form_submissions |

Модель согласуется целиком сейчас; поздние миграции могут уточнить поля после согласования соответствующей фазы.

### 2.5 SQL в миграциях (Prisma этого не выражает)

```sql
-- Формат slug и зарезервированные имена (D10; список дублируется в коде)
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_format
  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_not_reserved
  CHECK (slug NOT IN ('admin','api','www','app','mail','static','assets','status','help','support'));
-- Нормализованные email
ALTER TABLE users ADD CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email)));
ALTER TABLE platform_admins ADD CONSTRAINT platform_admins_email_normalized CHECK (email = lower(btrim(email)));

-- RLS: шаблон для каждой tenant-таблицы
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leads
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- memberships: дополнительно человек может ПРОЧИТАТЬ свои участия во всех компаниях
-- (нужно для списка компаний после центрального входа). Изменять — только в контексте компании.
CREATE POLICY membership_self_read ON memberships FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
```

`NULLIF(..., '')`: после транзакции с `SET LOCAL` настройка становится пустой строкой, а не NULL. Без NULLIF `''::uuid` давал бы ошибку; с NULLIF условие даёт NULL, и строк не видно (fail-closed).

| Таблица | RLS | Почему |
| --- | --- | --- |
| memberships, tenant_modules, tenant_sessions, leads, lead_status_history, form_endpoints, form_submissions, tenant_audit_logs | да | данные компании |
| tenants, modules | нет | нужны до появления контекста (разбор hostname, каталог); runtime-роль только читает |
| users, user_identities, user_sessions, login_handoffs | нет | аккаунт человека вне компаний; доступ только через модуль auth (Phase 3); бизнес-модулям запрещён импорт репозитория пользователей (lint-правило) |
| platform_admins, platform_sessions, platform_audit_logs | нет | вне компаний; доступ через маршруты platform-контекста |

## 3. Роли БД и окружение (D8 — согласовано)

Сейчас API подключается суперпользователем из `POSTGRES_USER`, а **суперпользователь обходит RLS**. Поэтому в 2.5 переход на отдельную роль обязателен:

| Роль | Назначение | Права |
| --- | --- | --- |
| `POSTGRES_USER` (существующий) | только bootstrap ролей | суперпользователь; приложение его не использует |
| `modulyn_owner` | владелец схемы, `prisma migrate` | DDL; LOGIN; без SUPERUSER |
| `modulyn_app` | runtime API | DML на таблицы приложения, только SELECT на `tenants` и `modules`; `NOBYPASSRLS`, не владелец |

Переменные: `DATABASE_URL` (app) и `MIGRATION_DATABASE_URL` (owner). `pnpm env:init` генерирует отдельные пароли и не трогает существующий `.env`. Роли создаёт идемпотентный `pnpm db:roles`. `docker-entrypoint-initdb.d` не подходит: он срабатывает только на пустом volume, а локальный volume сохраняется. В Compose добавится одноразовый сервис `migrate`; `api` ждёт его успешного завершения.

## 4. Подшаги Phase 2

**2.1 — Согласование схемы.** Пользователь согласует раздел 2 (редакция 2). Результат: явное «согласовано» в SPEC. До этого миграции не создаются.

**2.2 — Prisma и миграции.** Проверить стабильную версию Prisma и совместимость с Node 26 / TS 6 / ESM. Добавить `apps/api/prisma/schema.prisma`, `prisma.config.ts`, миграцию таблиц Phase 2 с CHECK, скрипты `db:migrate`, `db:roles`, сервис `migrate`. Prisma заменяет временный `pg`-пул в `DatabaseService`; readiness остаётся.
Проверки: миграция чистой БД; повторный `migrate deploy` без изменений; FK отклоняет назначение лида человеку без участия в этой компании; CHECK отклоняет неверный и зарезервированный slug и ненормализованный email; `prisma validate` проходит.

**2.3 — Tenant resolution.** Middleware NestJS читает `Host` (nginx перезаписывает его; `X-Forwarded-Host` от клиента не используется). Алгоритм: lower-case, отрезать порт, проверить суффикс `APP_BASE_DOMAIN` (`localhost` локально), ровно одна метка перед доменом, формат DNS-метки. Затем: `admin` → platform-контекст; `app` → центральный вход (Phase 3); прочие зарезервированные → 404; поиск `tenants.slug`; неизвестный или `SUSPENDED` → одинаковый 404 (D9). `/api/health*` работает без tenant. Для проверки — `GET /api/tenant`: только `slug` и `displayName`.
Проверки: unit-тесты разбора (регистр, порт, вложенные поддомены, `localhost` без метки, пробелы, punycode, чужой домен); интеграционный тест nova / company-b / suspended / unknown / admin / app.

**2.4 — Tenant context и scoped-доступ.** `TenantContext` на `AsyncLocalStorage` (`tenantId`, `slug`). `TenantDb.run(fn)` открывает транзакцию, выполняет `select set_config('app.tenant_id', $1, true)` и передаёт `fn` транзакционный клиент. Без контекста — исключение до SQL. Репозитории получают только этот клиент. ESLint `no-restricted-imports` запрещает сырой PrismaClient вне модуля database.
Проверки: 100 параллельных запросов вперемешку nova/company-b; вызов без контекста падает; ошибка в транзакции не оставляет контекст.

**2.5 — RLS и роли.** Политики по разделу 2.5, GRANT по разделу 3, переключение API на `modulyn_app`.
Проверки: без контекста — 0 строк и запрет INSERT; контекст A не видит и не меняет строки B; INSERT с чужим `tenant_id` отклоняется `WITH CHECK`; соединение после транзакции не помнит tenant (пул `max=1` в тесте); `membership_self_read` показывает человеку только его участия и не даёт их менять; у `modulyn_app` нет BYPASSRLS и права отключить RLS.

**2.6 — Fixtures и интеграционные тесты.** Синтетический seed: компании `nova`, `company-b`, `suspended-co`; модуль `leads`; пользователи: администратор Nova, администратор Company B и **один менеджер, состоящий в обеих компаниях**; лиды с историей. Тестовая база `modulyn_test`, реальные данные не используются. Обновить README, `.env.example`, smoke и SPEC.
Проверки: `pnpm check` и интеграционный набор между двумя компаниями (чтение, изменение, удаление, списки, история, назначение, IDOR по известному id чужого лида). Отдельно: общий менеджер в контексте Nova не видит лиды Company B и наоборот. Также: отсутствие контекста, откат транзакции, конкурентность; `pnpm stack:up` + smoke.

## 5. Критерии готовности Phase 2

1. Схема согласована и записана в SPEC; миграции применяются к чистой БД.
2. Межфирменные связи невозможны на уровне FK.
3. Hostname → tenant работает для валидных, неизвестных, отключённых и зарезервированных имён без утечки информации.
4. Код не может выполнить tenant-запрос без контекста.
5. Runtime-роль не обходит RLS; контекст не переносится через пул.
6. Пользователь с участием в двух компаниях видит данные только той компании, в контексте которой выполняется запрос.
7. Все проверки Phase 1 и новые интеграционные тесты проходят; фактические результаты записаны в SPEC.

## 6. Решения

| ID | Решение | Статус |
| --- | --- | --- |
| D1′ | Один аккаунт человека (`User`) и участие в компаниях (`Membership`); центральный вход с выбором компании и переключатель в меню | согласовано 2026-11-16 («да») |
| D1-G | Вход и по паролю, и через Google — сразу в MVP (Phase 3) | согласовано 2026-11-16 («делаем сразу и по паролю и через Google») |
| D2 | `PlatformAdmin` — отдельная таблица и сессии | согласовано 2026-11-16 |
| D3 | RLS как второй уровень защиты | согласовано 2026-11-16 («включаем») |
| D4 | Модель целиком сейчас; миграции по фазам (раздел 2.4) | согласовано 2026-11-16; таблицы переформулированы под D1′ и D6 |
| D5 | UUIDv7 для всех id | согласовано 2026-11-16 |
| D6 | Заявки с сайта через webhook (`WEB_FORM`), письмо на почту остаётся; IMAP не делаем; источники `WEB_FORM`, `MANUAL` | согласовано 2026-11-16 («так делаем»; доступ к админке сайта есть) |
| D7 | Prisma — последняя стабильная версия на момент 2.2 с адаптером `pg` | согласовано 2026-11-16 |
| D8 | Роли `modulyn_owner` / `modulyn_app`, идемпотентный `db:roles`, volume сохраняется | согласовано 2026-11-16 |
| D9 | Неизвестная и отключённая компания → одинаковый 404 | согласовано 2026-11-16 |
| D10 | Зарезервированные slug: admin, api, www, app, mail, static, assets, status, help, support | согласовано 2026-11-16 |
| D11 | Приём заявок не зависит от сайта: универсальная точка приёма с режимами SERVER (секрет) и BROWSER (публичный ключ + origin + лимиты + антиспам), настраиваемое сопоставление полей; подключение каждого сайта — отдельная настройка, а не код CRM | согласовано 2026-11-16 («подтверждаю», вместе с одобрением Phase 2); предложено после замечания пользователя «другие компании могут быть реализованы по-разному и на других хостах» |

Открытые вопросы на будущие фазы (Phase 2 не блокируют): политика MANAGER для неназначенных лидов (3.1 / 7.1); поля форм сайта и способ отправки — серверный обработчик на Strato или браузер (8.8); приглашения и выдача первого доступа (5.1).

## 7. Технические риски

- **Composite FK и nullable-связь в Prisma.** Для `Lead.assignee` нельзя использовать `disconnect`: Prisma попытается обнулить и `tenantId`. Назначение снимается записью `assignedToId = null`. Проверяется тестом в 2.2.
- **Транзакция на каждый tenant-запрос** — цена надёжной установки контекста; при необходимости измерим.
- **Platform-операции с tenant-таблицами** (`tenant_modules`, первое участие TENANT_ADMIN) выполняются явно в контексте целевой компании. RLS не отличает платформу от компании, поэтому запрет доступа платформы к лидам обеспечивают маршруты и guards (4.5).
- **Таблица `users` без RLS.** Изоляцию аккаунтов обеспечивает код: бизнес-модули не импортируют репозиторий пользователей, ответ API не раскрывает существование email (Phase 5).
- **Webhook с сайтов.** У разных компаний сайты на разных технологиях и хостингах. В режиме BROWSER ключ виден посетителям и не является секретом; защита — проверка Origin (её можно подделать вне браузера, поэтому это лишь фильтр), лимиты по IP и точке, honeypot, валидация, при необходимости капча. Риск — спам, но не доступ к данным: точка приёма только создаёт лиды и ничего не возвращает. Режим выбирается для каждого сайта при его подключении (8.8) — CRM от этого выбора не зависит.

## 8. Реализация Phase 2 (P2-002, 2026-11-16)

Отличия реализации от плана и мелкие технические решения внутри одобренной фазы:

- **schema.prisma содержит только таблицы Phase 2** (D4). Модели Phase 3 и Phase 8 из раздела 2.2 добавляются в файл вместе с их миграциями.
- **SQL первой миграции написан вручную в формате Prisma.** В среде разработки агента был недоступен сервер бинарников Prisma (`binaries.prisma.sh`), поэтому `prisma migrate dev/diff/deploy` там не запускались. `prisma validate` и `prisma generate` работают через WASM и были выполнены. Соответствие SQL и схемы проверяется у пользователя командой `pnpm db:drift` после `pnpm db:setup` (ожидается пустой diff).
- **Две миграции:** `20261116120000_phase2_init` (таблицы, индексы, FK, CHECK) и `20261116130000_phase2_rls` (RLS, политики, GRANT).
- **Проверка runtime-роли в API.** `DatabaseService.assertRuntimeRole()`: если `DATABASE_URL` — суперпользователь, BYPASSRLS или владелец таблиц, readiness и все tenant-операции отказывают с 503 (fail-closed). Это защищает от случайного подключения API под ролью, для которой RLS не действует.
- **`TRUST_DEV_PROXY_HOST`.** Next.js dev-сервер при проксировании `/api` подменяет Host. Только в `pnpm dev` и только для loopback-соединений API берёт hostname из `X-Forwarded-Host`, который Next.js перезаписывает сам. В production флаг запрещён на старте.
- **Права runtime-роли минимальны для Phase 2:** `tenants`/`modules` — только чтение; история статусов и аудит — только INSERT/SELECT; запись в platform-таблицы — в миграциях Phase 3–4.
- **Интеграционные тесты** создают отдельную базу `<POSTGRES_DB>_test` и применяют те же SQL-файлы, что `prisma migrate deploy`.
