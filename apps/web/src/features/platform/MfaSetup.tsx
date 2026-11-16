'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MfaEnableResponse, MfaSetupResponse } from '@modulyn/contracts';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
import { ApiError, post } from '../auth/api';
import { QrCode } from './QrCode';

/**
 * Обязательная настройка второго фактора администратора платформы (B2):
 * QR-код → код из приложения → 10 кодов восстановления (показываются один раз).
 */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  // Каждый вызов setup выпускает новый секрет: в режиме разработки React запускает effect дважды,
  // поэтому запрос выполняется один раз на монтирование, иначе QR-код разошёлся бы с секретом в БД.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    post<MfaSetupResponse>('/api/auth/mfa/setup').then(setSetup, () => setError('Не удалось начать настройку. Обновите страницу.'));
  }, []);

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setRecovery((await post<MfaEnableResponse>('/api/auth/mfa/enable', { code: code.trim() })).recoveryCodes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось подтвердить код');
    } finally { setBusy(false); }
  }

  if (recovery) {
    return (
      <Centered>
        <Brand />
        <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Коды восстановления</h1>
        <p className="mb-4 text-sm leading-6 text-slate-600">Сохраните их в надёжном месте. Каждый код подходит один раз, если телефон недоступен. Больше они показаны не будут.</p>
        <Card>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm">{recovery.map(c => <li key={c}>{c}</li>)}</ul>
          <div className="mt-4 space-y-3">
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(recovery.join('\n'))}>Скопировать</Button>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> Я сохранил коды</label>
            <Button disabled={!saved} onClick={onDone}>Продолжить</Button>
          </div>
        </Card>
      </Centered>
    );
  }

  return (
    <Centered>
      <Brand />
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">Второй фактор входа</h1>
      <p className="mb-4 text-sm leading-6 text-slate-600">Отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator, Microsoft Authenticator, 1Password и др.) и введите 6-значный код.</p>
      <Card>
        {error && <div className="mb-4"><Notice>{error}</Notice></div>}
        {setup ? (
          <form onSubmit={confirm} className="space-y-4">
            <div className="flex justify-center"><QrCode value={setup.otpauthUri} /></div>
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer">Не получается отсканировать?</summary>
              <p className="mt-2">Введите ключ вручную: <code className="break-all font-mono">{setup.secret}</code></p>
            </details>
            <Field label="Код из приложения" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? 'Проверка…' : 'Подтвердить'}</Button>
          </form>
        ) : !error && <p className="text-sm text-slate-500">Подготовка…</p>}
      </Card>
    </Centered>
  );
}
