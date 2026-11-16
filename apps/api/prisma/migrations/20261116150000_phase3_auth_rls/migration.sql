-- Phase 3 — RLS и права runtime-роли для таблиц входа (specs/phase3_design.md, раздел 4).

-- ───────────── tenant_sessions: данные компании ─────────────
ALTER TABLE "tenant_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_sessions"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Человек может найти и ОТОЗВАТЬ свои сессии во всех компаниях (logout, «выйти везде», смена пароля)
-- в контексте app.user_id. Создавать сессии — только в контексте компании (политики INSERT нет).
-- UPDATE в PostgreSQL требует, чтобы строка проходила и политику SELECT, поэтому нужны обе.
CREATE POLICY "tenant_session_self_read" ON "tenant_sessions" FOR SELECT
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY "tenant_session_self_revoke" ON "tenant_sessions" FOR UPDATE
  USING      ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- ───────────── Права runtime-роли ─────────────
-- Аккаунт и сессии вне компаний (без RLS): доступ только из модуля auth (src/database/auth-store.service.ts).
GRANT SELECT, INSERT, UPDATE ON "user_identities", "user_sessions", "platform_sessions", "tenant_sessions" TO modulyn_app;
-- Коды перехода и счётчики входа удаляются по истечении.
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_handoffs", "auth_throttle" TO modulyn_app;
-- Вход Platform Admin и смена его пароля. Создание администраторов — Phase 4.1 (не runtime-ролью).
GRANT SELECT, UPDATE ON "platform_admins" TO modulyn_app;
