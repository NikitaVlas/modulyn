-- Phase 5 — участники компании, приглашения, восстановление пароля (specs/phase5_design.md, раздел 4).
-- DDL сгенерирован prisma migrate diff; ограничения, RLS и права — в конце.

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "password_resets_user_id_idx" ON "password_resets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_created_at_idx" ON "invitations"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_invited_by_id_fkey" FOREIGN KEY ("tenant_id", "invited_by_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────── Ограничения ─────────────
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_normalized" CHECK ("email" = lower(btrim("email")));
-- C8: одно действующее приглашение на email в компании (повторная отправка отзывает старое).
CREATE UNIQUE INDEX "invitations_one_open_per_email" ON "invitations" ("tenant_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ───────────── RLS: приглашения — данные компании ─────────────
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations"
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- C10: по ссылке из письма человек ещё не в компании. Зная токен (в контексте app.invite_token_hash),
-- он может прочитать и отметить принятым ТОЛЬКО своё приглашение — ничего больше в компании.
CREATE POLICY "invitation_by_token_read" ON "invitations" FOR SELECT
  USING ("token_hash" = NULLIF(current_setting('app.invite_token_hash', true), ''));
CREATE POLICY "invitation_by_token_accept" ON "invitations" FOR UPDATE
  USING      ("token_hash" = NULLIF(current_setting('app.invite_token_hash', true), ''))
  WITH CHECK ("token_hash" = NULLIF(current_setting('app.invite_token_hash', true), ''));

-- ───────────── Права runtime-роли ─────────────
GRANT SELECT, INSERT, UPDATE ON "invitations" TO modulyn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "password_resets" TO modulyn_app;
