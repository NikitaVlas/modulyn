-- Phase 2.5 — Row-Level Security и права runtime-роли (D3, D8).
-- Требует ролей modulyn_owner / modulyn_app (apps/api/scripts/db-roles.mjs) и выполняется владельцем таблиц.
--
-- Контекст компании задаётся в начале каждой транзакции API:
--   SELECT set_config('app.tenant_id', '<uuid>', true);   -- true = только до конца транзакции
-- NULLIF(..., '') — после транзакции настройка становится пустой строкой; без NULLIF ''::uuid давал бы ошибку,
-- а так условие даёт NULL и строк не видно (fail-closed).

-- ───────────── RLS на всех таблицах с tenant_id ─────────────

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "memberships"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- Человек может ПРОЧИТАТЬ свои участия во всех компаниях (список компаний после центрального входа, Phase 3).
-- Политики одной команды объединяются через OR; изменять участия можно только в контексте компании.
CREATE POLICY "membership_self_read" ON "memberships" FOR SELECT
  USING ("user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid);

ALTER TABLE "tenant_modules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_modules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_modules"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "leads"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "lead_status_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_status_history" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "lead_status_history"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tenant_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_audit_logs"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ───────────── Права runtime-роли (минимально необходимые на Phase 2) ─────────────
-- Права на запись в tenants/modules/platform_* выдаются миграциями фаз, где появляются эти операции (Phase 3–4).

GRANT SELECT ON "tenants", "modules" TO modulyn_app;
GRANT SELECT, INSERT, UPDATE ON "users" TO modulyn_app;
GRANT SELECT, INSERT, UPDATE ON "memberships", "tenant_modules" TO modulyn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO modulyn_app;
-- История статусов и аудит компании — только добавление и чтение.
GRANT SELECT, INSERT ON "lead_status_history", "tenant_audit_logs" TO modulyn_app;
