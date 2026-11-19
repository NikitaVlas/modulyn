-- Phase 10 — язык интерфейса и писем (I1, I2, I4, I9).
-- Немецкий по умолчанию: все существующие аккаунты, администраторы платформы и приглашения получают 'de'.
-- Права не меняются: роль API уже может читать и обновлять "users", "platform_admins" и "invitations" (Phase 2–5);
-- свой язык человек меняет только через PUT /api/auth/locale (строка своего аккаунта).

-- CreateEnum
CREATE TYPE "locale" AS ENUM ('de', 'en', 'ru');

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "locale" "locale" NOT NULL DEFAULT 'de';

-- AlterTable
ALTER TABLE "platform_admins" ADD COLUMN     "locale" "locale" NOT NULL DEFAULT 'de';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" "locale" NOT NULL DEFAULT 'de';
