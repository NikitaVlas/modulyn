-- Phase 8 — точки приёма заявок с сайтов и журнал приёма (specs/phase8_design.md, раздел 5).
-- DDL сгенерирован prisma migrate diff; ограничения, RLS и права — в конце.

-- CreateEnum
CREATE TYPE "FormEndpointMode" AS ENUM ('SERVER', 'BROWSER');

-- CreateEnum
CREATE TYPE "FormSubmissionStatus" AS ENUM ('IMPORTED', 'DUPLICATE', 'REJECTED');

-- CreateTable
CREATE TABLE "form_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "mode" "FormEndpointMode" NOT NULL,
    "public_key" VARCHAR(64) NOT NULL,
    "secret_prefix" VARCHAR(12),
    "secret_hash" VARCHAR(128),
    "allowed_origins" TEXT[],
    "source_detail" VARCHAR(100),
    "field_mapping" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "form_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "status" "FormSubmissionStatus" NOT NULL,
    "error_code" VARCHAR(100),
    "lead_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "form_endpoints_public_key_key" ON "form_endpoints"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "form_endpoints_tenant_id_id_key" ON "form_endpoints"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "form_submissions_tenant_id_endpoint_id_idempotency_key_idx" ON "form_submissions"("tenant_id", "endpoint_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "form_submissions_tenant_id_created_at_idx" ON "form_submissions"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "form_endpoints" ADD CONSTRAINT "form_endpoints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_tenant_id_endpoint_id_fkey" FOREIGN KEY ("tenant_id", "endpoint_id") REFERENCES "form_endpoints"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Ограничения ─────────────
-- W3: одна принятая заявка на ключ повтора в точке приёма (дубли пишутся отдельными строками DUPLICATE).
CREATE UNIQUE INDEX "form_submissions_one_import_per_key" ON "form_submissions" ("tenant_id", "endpoint_id", "idempotency_key")
  WHERE "status" = 'IMPORTED';
ALTER TABLE "form_endpoints" ADD CONSTRAINT "form_endpoints_secret_by_mode"
  CHECK (("mode" = 'SERVER' AND "secret_hash" IS NOT NULL) OR ("mode" = 'BROWSER' AND "secret_hash" IS NULL));

-- ───────────── RLS: данные компании ─────────────
ALTER TABLE "form_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_endpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "form_endpoints"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "form_submissions"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ───────────── Права runtime-роли ─────────────
GRANT SELECT, INSERT, UPDATE ON "form_endpoints" TO modulyn_app;
-- Журнал только дополняется; очистка старых записей — 9.5.
GRANT SELECT, INSERT ON "form_submissions" TO modulyn_app;