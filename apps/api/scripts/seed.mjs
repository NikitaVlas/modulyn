// Синтетические данные для разработки и интеграционных тестов (подшаг 2.6). Реальные данные не используются.
// Компании: nova, company-b (активные), suspended-co (отключена). Модуль leads.
// Пользователи: администратор каждой компании и один менеджер, который состоит в ОБЕИХ компаниях.
// Phase 3: у синтетических пользователей и администратора платформы один локальный пароль SEED_PASSWORD;
// admin@suspended.example состоит только в отключённой компании (список компаний у него пуст).
// Запуск: pnpm db:seed (под владельцем схемы, MIGRATION_DATABASE_URL). Повторный запуск ничего не дублирует.
import { createHash } from 'node:crypto';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

/** Только для локальной разработки и тестов; seed отказывается работать в production. */
export const SEED_PASSWORD = 'modulyn-local-dev-password';

/**
 * Phase 8: точка приёма Nova для локальной проверки — настроена так же, как для живого сайта
 * (форма пробной тренировки, режим SERVER, «Программа» в сообщении). Секрет только локальный.
 */
export const SEED_INTAKE = {
  publicKey: 'nova-local-trial-endpoint',
  secret: 'mdl_local-nova-trial-secret-for-development',
  name: 'Сайт bjjmoenchengladbach.de (локально)',
  sourceDetail: 'trial',
  fieldMapping: { extra: [{ field: 'program', label: 'Программа' }] },
};

export const SEED = {
  tenants: [
    { slug: 'nova', name: 'Nova BJJ (synthetic)', displayName: 'Nova CRM', status: 'ACTIVE' },
    { slug: 'company-b', name: 'Company B (synthetic)', displayName: 'Company B CRM', status: 'ACTIVE' },
    { slug: 'suspended-co', name: 'Suspended Co (synthetic)', displayName: 'Suspended CRM', status: 'SUSPENDED' },
  ],
  users: [
    { email: 'admin@nova.example', name: 'Nova Admin' },
    { email: 'admin@company-b.example', name: 'Company B Admin' },
    { email: 'manager@shared.example', name: 'Shared Manager' },
    { email: 'admin@suspended.example', name: 'Suspended Co Admin' },
  ],
  platformAdmins: [
    { email: 'platform@modulyn.example', name: 'Platform Admin' },
  ],
  memberships: [
    { tenant: 'nova', email: 'admin@nova.example', role: 'TENANT_ADMIN' },
    { tenant: 'nova', email: 'manager@shared.example', role: 'MANAGER' },
    { tenant: 'company-b', email: 'admin@company-b.example', role: 'TENANT_ADMIN' },
    { tenant: 'company-b', email: 'manager@shared.example', role: 'MANAGER' },
    { tenant: 'suspended-co', email: 'admin@suspended.example', role: 'TENANT_ADMIN' },
  ],
  leads: [
    { tenant: 'nova', name: 'Nova Lead 1', email: 'lead1@nova-visitor.example', source: 'WEB_FORM', sourceDetail: 'trial', assignee: 'manager@shared.example' },
    { tenant: 'nova', name: 'Nova Lead 2', phone: '+49 000 0000001', source: 'WEB_FORM', sourceDetail: 'contact' },
    { tenant: 'nova', name: 'Nova Lead 3', source: 'MANUAL' },
    { tenant: 'company-b', name: 'Company B Lead 1', email: 'lead1@b-visitor.example', source: 'WEB_FORM', assignee: 'manager@shared.example' },
    { tenant: 'company-b', name: 'Company B Lead 2', source: 'MANUAL' },
  ],
};

/** Выполняет fn в транзакции с контекстом компании (как TenantDb.runInTenant). */
function inTenant(prisma, tenantId, fn) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export async function seed(prisma) {
  const tenants = {};
  for (const t of SEED.tenants) {
    tenants[t.slug] = await prisma.tenant.upsert({ where: { slug: t.slug }, update: {}, create: t });
  }
  const leadsModule = await prisma.module.upsert({
    where: { key: 'leads' }, update: {},
    create: { key: 'leads', name: 'Leads', description: 'Заявки и их обработка' },
  });
  const passwordHash = await hash(SEED_PASSWORD, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const users = {};
  for (const u of SEED.users) {
    users[u.email] = await prisma.user.upsert({ where: { email: u.email }, update: {}, create: { ...u, passwordHash } });
    // Данные Phase 2 без пароля получают локальный пароль; существующий пароль не меняется.
    if (!users[u.email].passwordHash) users[u.email] = await prisma.user.update({ where: { id: users[u.email].id }, data: { passwordHash } });
  }
  const platformAdmins = {};
  for (const a of SEED.platformAdmins) {
    platformAdmins[a.email] = await prisma.platformAdmin.upsert({ where: { email: a.email }, update: {}, create: { ...a, passwordHash } });
  }
  for (const slug of ['nova', 'company-b', 'suspended-co']) {
    const tenantId = tenants[slug].id;
    await inTenant(prisma, tenantId, async tx => {
      if (slug !== 'suspended-co') {
        await tx.tenantModule.upsert({
          where: { tenantId_moduleId: { tenantId, moduleId: leadsModule.id } },
          update: {}, create: { tenantId, moduleId: leadsModule.id, enabled: true },
        });
      }
      for (const m of SEED.memberships.filter(x => x.tenant === slug)) {
        const userId = users[m.email].id;
        await tx.membership.upsert({
          where: { tenantId_userId: { tenantId, userId } }, update: {},
          create: { tenantId, userId, role: m.role },
        });
      }
      if (slug === 'nova') {
        const secretHash = createHash('sha256').update(SEED_INTAKE.secret).digest('hex');
        await tx.formEndpoint.upsert({
          where: { publicKey: SEED_INTAKE.publicKey }, update: {},
          create: {
            tenantId, mode: 'SERVER', publicKey: SEED_INTAKE.publicKey, name: SEED_INTAKE.name, sourceDetail: SEED_INTAKE.sourceDetail,
            fieldMapping: SEED_INTAKE.fieldMapping, secretHash, secretPrefix: SEED_INTAKE.secret.slice(0, 10), allowedOrigins: [],
          },
        });
      }
      if (await tx.lead.count() > 0) return; // уже засеяно
      for (const l of SEED.leads.filter(x => x.tenant === slug)) {
        const lead = await tx.lead.create({
          data: {
            tenantId, name: l.name, email: l.email ?? null, phone: l.phone ?? null, source: l.source,
            sourceDetail: l.sourceDetail ?? null, assignedToId: l.assignee ? users[l.assignee].id : null,
          },
        });
        await tx.leadStatusHistory.create({ data: { tenantId, leadId: lead.id, previousStatus: null, newStatus: 'NEW' } });
      }
    });
  }
  return { tenants, users, platformAdmins, leadsModule };
}

if (import.meta.main) {
  if (process.env.NODE_ENV === 'production') {
    console.error('db:seed refuses to run with NODE_ENV=production');
    process.exit(1);
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.error('db:seed requires MIGRATION_DATABASE_URL (run pnpm env:init)'); process.exit(1); }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seed(prisma);
    console.log('db:seed: synthetic tenants nova, company-b, suspended-co are ready.');
  } catch (error) {
    console.error('db:seed failed:', error?.code ?? error?.name ?? 'unknown error');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
