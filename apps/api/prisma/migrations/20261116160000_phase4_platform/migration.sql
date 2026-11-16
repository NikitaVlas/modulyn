-- Phase 4 — администрирование платформы (specs/phase4_design.md, раздел 4).
-- DDL сгенерирован prisma migrate diff; права runtime-роли — в конце.

-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "password_change_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "temp_password_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_last_step" BIGINT,
ADD COLUMN     "totp_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_change_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "temp_password_expires_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "platform_recovery_codes" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "code_hash" VARCHAR(128) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_recovery_codes_admin_id_idx" ON "platform_recovery_codes"("admin_id");

-- AddForeignKey
ALTER TABLE "platform_recovery_codes" ADD CONSTRAINT "platform_recovery_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Права runtime-роли (modulyn_app) ─────────────
-- Компании: создание и изменение только name, display_name, status. slug после создания не меняется (B4)
-- даже прямым SQL — права на этот столбец у runtime-роли нет.
GRANT INSERT ON "tenants" TO modulyn_app;
GRANT UPDATE ("name", "display_name", "status", "updated_at") ON "tenants" TO modulyn_app;

-- Администраторы платформы: API меняет только пароль и второй фактор. email, name, is_active меняет
-- только команда platform-admin под владельцем схемы (B9). Создавать администраторов runtime-роль не может (B1).
REVOKE UPDATE ON "platform_admins" FROM modulyn_app;
GRANT UPDATE ("password_hash", "password_change_required", "temp_password_expires_at",
              "totp_secret_enc", "totp_enabled_at", "totp_last_step", "updated_at") ON "platform_admins" TO modulyn_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_recovery_codes" TO modulyn_app;
-- Аудит платформы — только добавление и чтение.
GRANT SELECT, INSERT ON "platform_audit_logs" TO modulyn_app;
