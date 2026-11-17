-- Phase 9.5 — сроки хранения (F5), очистка (F7) и удаление заявки (F6).
-- Схема Prisma: только каскадное удаление истории вместе с заявкой (onDelete: Cascade); функцию и права Prisma не отслеживает.

-- ───────────── Очистка устаревших технических записей (F5, F7) ─────────────
-- Выполняется владельцем схемы (SECURITY DEFINER) с фиксированным search_path; приложение может ТОЛЬКО вызвать её,
-- прав DELETE на журналы и сессии у приложения нет. Правила и сроки — только здесь, параметров у функции нет.
-- Таблицы с FORCE RLS очищаются по одной компании за раз (контекст app.tenant_id), как и всё остальное.
-- Заявки и их история не трогаются никогда.
--
-- Сроки:
--   коды перехода, ссылки сброса пароля, счётчики лимитов — 1 день после окончания;
--   сессии (app, компании, платформы) — 30 дней после окончания или отзыва
--     (больше максимального срока жизни сессии — 30 дней, поэтому распознавание повтора старого токена не теряется);
--   приглашения — 30 дней после принятия, отзыва или истечения;
--   журнал приёма заявок с сайтов — 90 дней (W7);
--   журналы аудита компании и платформы — 365 дней.
-- Несколько экземпляров API: работает один (транзакционная advisory-блокировка), остальные получают {"skipped": true}.
CREATE FUNCTION "modulyn_cleanup"() RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  day_ago        timestamptz := now() - interval '1 day';
  month_ago      timestamptz := now() - interval '30 days';
  journal_cutoff timestamptz := now() - interval '90 days';
  audit_cutoff   timestamptz := now() - interval '365 days';
  previous_tenant text := current_setting('app.tenant_id', true);
  keep_user_sessions uuid[] := '{}';
  t record;
  n bigint;
  c_tenant_sessions bigint := 0;
  c_invitations bigint := 0;
  c_submissions bigint := 0;
  c_tenant_audit bigint := 0;
  result jsonb := '{}'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('modulyn_cleanup')) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  DELETE FROM "login_handoffs" WHERE "expires_at" < day_ago;
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('login_handoffs', n);
  DELETE FROM "password_resets" WHERE "expires_at" < day_ago OR "used_at" < day_ago;
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('password_resets', n);
  DELETE FROM "auth_throttle" WHERE "window_start" < day_ago;
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('auth_throttle', n);

  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    DELETE FROM "tenant_sessions" WHERE "tenant_id" = t."id"
      AND ("revoked_at" < month_ago OR LEAST("expires_at", "absolute_expires_at") < month_ago);
    GET DIAGNOSTICS n = ROW_COUNT; c_tenant_sessions := c_tenant_sessions + n;
    -- Оставшиеся сессии компании держат свои сессии входа (внешний ключ).
    keep_user_sessions := keep_user_sessions || ARRAY(SELECT "user_session_id" FROM "tenant_sessions" WHERE "tenant_id" = t."id");
    DELETE FROM "invitations" WHERE "tenant_id" = t."id" AND COALESCE("accepted_at", "revoked_at", "expires_at") < month_ago;
    GET DIAGNOSTICS n = ROW_COUNT; c_invitations := c_invitations + n;
    DELETE FROM "form_submissions" WHERE "tenant_id" = t."id" AND "created_at" < journal_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; c_submissions := c_submissions + n;
    DELETE FROM "tenant_audit_logs" WHERE "tenant_id" = t."id" AND "created_at" < audit_cutoff;
    GET DIAGNOSTICS n = ROW_COUNT; c_tenant_audit := c_tenant_audit + n;
  END LOOP;
  PERFORM set_config('app.tenant_id', COALESCE(previous_tenant, ''), true);
  result := result || jsonb_build_object('tenant_sessions', c_tenant_sessions, 'invitations', c_invitations,
                                         'form_submissions', c_submissions, 'tenant_audit_logs', c_tenant_audit);

  DELETE FROM "user_sessions" us
  WHERE ("revoked_at" < month_ago OR LEAST("expires_at", "absolute_expires_at") < month_ago)
    AND us."id" <> ALL (keep_user_sessions)
    AND NOT EXISTS (SELECT 1 FROM "login_handoffs" h WHERE h."user_session_id" = us."id");
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('user_sessions', n);
  DELETE FROM "platform_sessions" WHERE "revoked_at" < month_ago OR LEAST("expires_at", "absolute_expires_at") < month_ago;
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('platform_sessions', n);
  DELETE FROM "platform_audit_logs" WHERE "created_at" < audit_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('platform_audit_logs', n);

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION "modulyn_cleanup"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "modulyn_cleanup"() TO modulyn_app;

-- ───────────── Удаление заявки администратором компании (F6) ─────────────
-- DELETE на "leads" выдан в Phase 2. История удаляется ТОЛЬКО вместе с заявкой — каскадом внешнего ключа;
-- прямого DELETE/UPDATE истории у приложения по-прежнему нет (история неизменна).
-- В журнале приёма ссылка обнуляется (запись «принята» остаётся без связи с удалёнными данными): право только на этот столбец.
-- (SET NULL внешним ключом не подходит: ключ составной, обнулился бы и tenant_id.) Всё — под RLS компании.
ALTER TABLE "lead_status_history" DROP CONSTRAINT "lead_status_history_tenant_id_lead_id_fkey";
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
GRANT UPDATE ("lead_id") ON "form_submissions" TO modulyn_app;
