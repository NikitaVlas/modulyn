// Ночная резервная копия вне сервера (Phase 11, E9, E10). Работает в образе modulyn-backup (pg_dump 18, age, rclone).
//   node offsite-backup.mjs once   — одна копия сейчас (проверка настройки, ручной запуск: docker compose run --rm backup node … once)
//   node offsite-backup.mjs loop   — каждый день в BACKUP_TIME (UTC, по умолчанию 02:30); так запускает Compose
//
// Шаги: pg_dump + сводка (backup.mjs) → шифрование age ОТКРЫТЫМ ключом (BACKUP_AGE_RECIPIENT; закрытый ключ только у вас —
// украденный сервер не расшифрует свои же копии) → выгрузка rclone в BACKUP_REMOTE/daily → по воскресеньям копия в weekly,
// 1-го числа — в monthly → удаление сверх BACKUP_KEEP_* → сигнал BACKUP_PING_URL (успех) или <URL>/fail (ошибка, диск > 85 %).
// Расшифровка и проверка у себя: age -d -i key.txt modulyn-….dump.age > modulyn-….dump; pnpm db:restore-check modulyn-….dump
import { spawnSync } from 'node:child_process';
import { rmSync, statfsSync } from 'node:fs';
import { basename } from 'node:path';
import { backup } from './backup.mjs';

const recipient = process.env.BACKUP_AGE_RECIPIENT ?? '';
const remote = (process.env.BACKUP_REMOTE ?? '').replace(/\/+$/, '');
const keep = { daily: Number(process.env.BACKUP_KEEP_DAILY ?? 7), weekly: Number(process.env.BACKUP_KEEP_WEEKLY ?? 4), monthly: Number(process.env.BACKUP_KEEP_MONTHLY ?? 6) };
const ping = process.env.BACKUP_PING_URL ?? '';
const WORK = '/tmp/modulyn-backup';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${cmd} is not available: ${r.error.code}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || '').trim().split('\n').slice(-1)[0] ?? r.status}`);
  return r.stdout;
}

async function signal(ok, message) {
  if (!ping) return;
  try { await fetch(ok ? ping : `${ping.replace(/\/+$/, '')}/fail`, { method: 'POST', body: message.slice(0, 1000), signal: AbortSignal.timeout(10_000) }); }
  catch { console.error('backup: monitoring ping failed'); }
}

/** Удаляет самые старые пары .dump.age/.json сверх нормы. Имена с временем — порядок по имени = по времени. */
function prune(folder, limit) {
  const names = run('rclone', ['lsf', '--files-only', `${remote}/${folder}`]).split('\n').filter(n => /^modulyn-\d{8}-\d{6}\.(dump\.age|json)$/.test(n));
  const stamps = [...new Set(names.map(n => n.slice(0, 'modulyn-YYYYMMDD-HHMMSS'.length)))].sort();
  for (const stamp of stamps.slice(0, Math.max(0, stamps.length - limit))) {
    for (const n of names.filter(x => x.startsWith(stamp))) run('rclone', ['deletefile', `${remote}/${folder}/${n}`]);
  }
}

export async function offsiteOnce(now = new Date()) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient)) throw new Error('BACKUP_AGE_RECIPIENT must be an age public key (age1…)');
  if (!remote.includes(':')) throw new Error('BACKUP_REMOTE must be an rclone remote, e.g. offsite:modulyn-backups');
  rmSync(WORK, { recursive: true, force: true });
  const { file, manifest, rows } = await backup(WORK);
  const encrypted = `${file}.age`;
  run('age', ['-r', recipient, '-o', encrypted, file]);
  rmSync(file); // незашифрованная копия не покидает контейнер и не остаётся в нём
  const name = basename(encrypted); const summary = basename(manifest);
  run('rclone', ['copyto', encrypted, `${remote}/daily/${name}`]);
  run('rclone', ['copyto', manifest, `${remote}/daily/${summary}`]);
  const extra = [];
  if (now.getUTCDay() === 0) extra.push('weekly');
  if (now.getUTCDate() === 1) extra.push('monthly');
  for (const folder of extra) {
    run('rclone', ['copyto', `${remote}/daily/${name}`, `${remote}/${folder}/${name}`]);
    run('rclone', ['copyto', `${remote}/daily/${summary}`, `${remote}/${folder}/${summary}`]);
  }
  for (const folder of ['daily', 'weekly', 'monthly']) if (folder === 'daily' || extra.includes(folder)) prune(folder, keep[folder]);
  rmSync(WORK, { recursive: true, force: true });

  const fs = statfsSync('/');
  const usedPercent = Math.round(100 - (fs.bavail / fs.blocks) * 100);
  const message = `backup ${name}: ${rows} rows, uploaded to daily${extra.length ? ' + ' + extra.join(' + ') : ''}; disk ${usedPercent}% used`;
  console.log(`backup: ${message}`);
  if (usedPercent > 85) await signal(false, `disk ${usedPercent}% used — ${message}`);
  else await signal(true, message);
}

function msUntil(time, now = new Date()) {
  const [h, m] = (/^\d{2}:\d{2}$/.test(time) ? time : '02:30').split(':').map(Number);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function safeOnce() {
  try { await offsiteOnce(); return true; }
  catch (error) {
    console.error(`backup: FAILED — ${error.message}`);
    await signal(false, `backup failed: ${error.message}`);
    return false;
  }
}

if (import.meta.main) {
  const mode = process.argv[2] ?? 'loop';
  if (mode === 'once') process.exitCode = (await safeOnce()) ? 0 : 1;
  else {
    console.log(`backup: daily at ${process.env.BACKUP_TIME ?? '02:30'} UTC`);
    for (;;) {
      await new Promise(r => setTimeout(r, msUntil(process.env.BACKUP_TIME ?? '02:30')));
      await safeOnce();
    }
  }
}
