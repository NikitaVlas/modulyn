-- Phase 6 — каталог модулей из реестра кода (specs/phase6_design.md, M1, M3).
-- Схема не меняется: modules и tenant_modules созданы в Phase 2. Только данные.

-- Каталог: модуль «Заявки». Название и описание приводятся к реестру (apps/api/src/modules/registry.ts).
INSERT INTO "modules" ("id", "key", "name", "description")
VALUES (gen_random_uuid(), 'leads', 'Заявки', 'Заявки с сайта и их обработка')
ON CONFLICT ("key") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description";

-- M3: у уже существующих компаний «Заявки» включены (если запись ещё не создана).
-- tenant_modules под FORCE RLS даже для владельца, поэтому запись делается в контексте каждой компании.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', t."id"::text, true);
    INSERT INTO "tenant_modules" ("tenant_id", "module_id", "enabled", "updated_at")
    SELECT t."id", m."id", true, now() FROM "modules" m WHERE m."key" = 'leads'
    ON CONFLICT ("tenant_id", "module_id") DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
