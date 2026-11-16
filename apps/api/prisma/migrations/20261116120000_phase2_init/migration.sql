-- Phase 2.2 — базовая модель (specs/phase2_design.md, редакция 2).
-- DDL в формате, который генерирует Prisma для schema.prisma, плюс CHECK-ограничения в конце.
-- Миграцию выполняет владелец схемы modulyn_owner (см. apps/api/scripts/db-roles.mjs).

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('TENANT_ADMIN', 'MANAGER');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'CONTACTED', 'CONVERTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('WEB_FORM', 'MANUAL');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "display_name" VARCHAR(200) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "password_hash" TEXT,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "actor_admin_id" UUID,
    "target_tenant_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modules" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_modules" (
    "tenant_id" UUID NOT NULL,
    "module_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("tenant_id","module_id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(50),
    "message" TEXT,
    "source" "LeadSource" NOT NULL,
    "source_detail" VARCHAR(100),
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "assigned_to_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "previous_status" "LeadStatus",
    "new_status" "LeadStatus" NOT NULL,
    "changed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(50),
    "entity_id" UUID,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_tenant_id_created_at_idx" ON "platform_audit_logs"("target_tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "modules_key_key" ON "modules"("key");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_created_at_idx" ON "leads"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_tenant_id_status_created_at_idx" ON "leads"("tenant_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "leads_tenant_id_assigned_to_id_idx" ON "leads"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenant_id_id_key" ON "leads"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "lead_status_history_tenant_id_lead_id_created_at_idx" ON "lead_status_history"("tenant_id", "lead_id", "created_at");

-- CreateIndex
CREATE INDEX "tenant_audit_logs_tenant_id_created_at_idx" ON "tenant_audit_logs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_actor_admin_id_fkey" FOREIGN KEY ("actor_admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_target_tenant_id_fkey" FOREIGN KEY ("target_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_assigned_to_id_fkey" FOREIGN KEY ("tenant_id", "assigned_to_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_tenant_id_lead_id_fkey" FOREIGN KEY ("tenant_id", "lead_id") REFERENCES "leads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_status_history" ADD CONSTRAINT "lead_status_history_tenant_id_changed_by_id_fkey" FOREIGN KEY ("tenant_id", "changed_by_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_audit_logs" ADD CONSTRAINT "tenant_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_audit_logs" ADD CONSTRAINT "tenant_audit_logs_tenant_id_actor_user_id_fkey" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── Ограничения, которые Prisma не выражает ─────────────

-- slug: DNS-метка в нижнем регистре; зарезервированные имена (D10) дублируются в коде (tenancy/hostname.ts).
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_not_reserved"
  CHECK ("slug" NOT IN ('admin', 'api', 'www', 'app', 'mail', 'static', 'assets', 'status', 'help', 'support'));

-- email хранится нормализованным: без пробелов по краям и в нижнем регистре.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_email_normalized" CHECK ("email" = lower(btrim("email")));
