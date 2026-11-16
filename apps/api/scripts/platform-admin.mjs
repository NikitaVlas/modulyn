// Управление администраторами платформы с сервера (Phase 4.1, решения B1, B8, B9). Интерфейса для этого нет.
// Работает под владельцем схемы (MIGRATION_DATABASE_URL): у runtime-роли API нет права создавать администраторов.
//
//   create         --email <email> --name <имя>   новый администратор; временный пароль печатается один раз
//   reset-password --email <email>                новый временный пароль; все сессии администратора отзываются
//   reset-2fa      --email <email>                сброс второго фактора (потерян телефон и коды); сессии отзываются
//   block | unblock --email <email>               блокировка входа / снятие блокировки
//
// Локально: pnpm platform:admin create --email you@example.com --name "Имя"
// В Docker: docker compose run --rm migrate node apps/api/scripts/platform-admin.mjs create --email ... --name ...
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const TEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789A'; // 32 символа без похожих (0/O, 1/l/I)

export function temporaryPassword(length = 20) {
  return Array.from(randomBytes(length), byte => ALPHABET[byte & 31]).join('');
}

function fail(message) {
  console.error('platform-admin: ' + message);
  process.exit(1);
}

export async function run(prisma, command, { email, name }) {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized) || normalized.length > 320) throw new Error('--email is required and must be a valid email');
  const tempFields = async () => {
    const password = temporaryPassword();
    const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    return { password, data: { passwordHash, passwordChangeRequired: true, tempPasswordExpiresAt: new Date(Date.now() + TEMP_TTL_MS) } };
  };
  const revokeSessions = adminId => prisma.platformSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
  const audit = (action, adminId) => prisma.platformAuditLog.create({ data: { action, actorAdminId: null, metadata: { via: 'cli', targetAdminId: adminId } } });

  if (command === 'create') {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (trimmedName.length === 0 || trimmedName.length > 200) throw new Error('--name is required (1–200 characters)');
    if (await prisma.platformAdmin.findUnique({ where: { email: normalized } })) throw new Error('an administrator with this email already exists');
    const { password, data } = await tempFields();
    const admin = await prisma.platformAdmin.create({ data: { email: normalized, name: trimmedName, ...data } });
    await audit('admin.created', admin.id);
    return { password };
  }

  const admin = await prisma.platformAdmin.findUnique({ where: { email: normalized } });
  if (!admin) throw new Error('administrator not found');
  if (command === 'reset-password') {
    const { password, data } = await tempFields();
    await prisma.platformAdmin.update({ where: { id: admin.id }, data });
    await revokeSessions(admin.id);
    await audit('admin.password_reset', admin.id);
    return { password };
  }
  if (command === 'reset-2fa') {
    await prisma.$transaction([
      prisma.platformAdmin.update({ where: { id: admin.id }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } }),
      prisma.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } }),
    ]);
    await revokeSessions(admin.id);
    await audit('admin.mfa_reset', admin.id);
    return {};
  }
  if (command === 'block' || command === 'unblock') {
    await prisma.platformAdmin.update({ where: { id: admin.id }, data: { isActive: command === 'unblock' } });
    if (command === 'block') await revokeSessions(admin.id);
    await audit(command === 'block' ? 'admin.blocked' : 'admin.unblocked', admin.id);
    return {};
  }
  throw new Error('unknown command');
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { email: { type: 'string' }, name: { type: 'string' } } });
  const command = positionals[0];
  if (!['create', 'reset-password', 'reset-2fa', 'block', 'unblock'].includes(command ?? '')) {
    fail('usage: platform-admin <create|reset-password|reset-2fa|block|unblock> --email <email> [--name <name>]');
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) fail('MIGRATION_DATABASE_URL is required (schema owner; run pnpm env:init)');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const result = await run(prisma, command, values);
    console.log(`platform-admin: ${command} done for ${values.email.trim().toLowerCase()}.`);
    if (result.password) {
      console.log('');
      console.log(`Temporary password (shown once, valid 7 days, must be changed at first sign-in): ${result.password}`);
      console.log('After the password change the administrator must set up two-factor authentication.');
    }
  } catch (error) {
    fail(error?.message ?? 'failed');
  } finally {
    await prisma.$disconnect();
  }
}
