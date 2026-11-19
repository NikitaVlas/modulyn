'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InvitationAcceptResponse, InvitationInspectResponse } from '@modulyn/contracts';
import { Brand, Button, Card, Centered, Field, Loading, Notice } from '../../components/ui';
import { LanguageSwitcher, useI18n } from '../../i18n/client';
import { ApiError, originOf, post } from '../auth/api';

const STORAGE_KEY = 'modulyn.invite';

/**
 * Токен из адреса после # (C10): браузер не отправляет эту часть на сервер. Сохраняется на время вкладки,
 * чтобы пережить переход на страницу входа, и убирается из адресной строки.
 */
function takeToken(): string | null {
  const fromHash = window.location.hash.slice(1);
  try {
    if (fromHash) {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return fromHash;
    }
    return sessionStorage.getItem(STORAGE_KEY);
  } catch { return fromHash || null; }
}

function forget() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* нет доступа к хранилищу — ничего страшного */ }
}

/**
 * Принятие приглашения (5.2, C2) на app.<домен>. Страница открывается на языке приглашения (Phase 10, I4);
 * новый аккаунт получает язык, на котором человек принял приглашение.
 */
export function InviteAccept({ baseDomain, error }: { baseDomain: string; error?: string | undefined }) {
  const { t, locale, setLocale } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<InvitationInspectResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(error === 'google' ? t('invite.googleFailed') : null);

  const load = useCallback((value: string, applyLocale: boolean) => {
    post<InvitationInspectResponse>('/api/invitations/inspect', { token: value }, { retry: false }).then(data => {
      setInfo(data);
      if (applyLocale) setLocale(data.locale);
      setName(current => current || data.name);
      setState(data.status === 'open' ? 'ready' : 'invalid');
    }, () => setState('invalid'));
  }, [setLocale]);

  useEffect(() => {
    // Токен доступен только в браузере (часть адреса после #), поэтому читается после монтирования.
    const value = takeToken();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- однократная инициализация из адреса страницы
    if (!value) { setState('invalid'); return; }
    setToken(value);
    load(value, true);
  }, [load]);

  function enterCompany(slug: string) {
    forget();
    window.location.href = originOf(slug, baseDomain) + '/api/auth/handoff/start';
  }

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try { await action(); }
    catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('invite.acceptFailed'));
      if (token && e instanceof ApiError && e.status === 409) load(token, false); // аккаунт уже есть — показать вход
    } finally { setBusy(false); }
  }

  const accept = (body: Record<string, string> = {}) => act(async () => {
    const r = await post<InvitationAcceptResponse>('/api/invitations/accept', { token, ...body }, { retry: false });
    enterCompany(r.tenantSlug);
  });

  function submitNew(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) { setMessage(t('password.mismatch')); return; }
    void accept({ name, password, locale });
  }

  const google = () => act(async () => {
    const r = await post<{ url: string }>('/api/invitations/google', { token }, { retry: false });
    window.location.href = r.url;
  });

  const logout = () => act(async () => {
    await post('/api/auth/logout', {}, { retry: false });
    if (token) load(token, false);
  });

  const header = <div className="flex items-center justify-between gap-3"><Brand /><LanguageSwitcher /></div>;
  if (state === 'loading') return <Loading />;
  if (state === 'invalid' || !info) {
    return (
      <Centered>
        {header}
        <h1 className="mb-4 mt-3 text-2xl font-semibold tracking-tight">{t('invite.title')}</h1>
        <Notice>{t('invite.invalid')}</Notice>
      </Centered>
    );
  }

  return (
    <Centered>
      {header}
      <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">{t('invite.titleCompany', { company: info.companyName })}</h1>
      <p className="mb-6 text-sm leading-6 text-slate-600">{t(info.role === 'TENANT_ADMIN' ? 'invite.asAdmin' : 'invite.asManager')} · {info.email}</p>
      {message && <div className="mb-4"><Notice>{message}</Notice></div>}
      <Card>
        {info.signedInAs === info.email ? (
          <Button disabled={busy} onClick={() => void accept()}>{t('invite.accept')}</Button>
        ) : info.signedInAs ? (
          <div className="space-y-4 text-sm">
            <p>{t('invite.signedInAs', { who: info.signedInAs, email: info.email })}</p>
            <Button variant="secondary" disabled={busy} onClick={() => void logout()}>{t('invite.signOutContinue')}</Button>
          </div>
        ) : info.accountExists ? (
          <div className="space-y-4 text-sm">
            <p>{t('invite.hasAccount')}</p>
            <a href="/login?next=invite" className="block w-full rounded-md bg-teal-800 px-4 py-2 text-center font-medium text-white hover:bg-teal-900">{t('common.signIn')}</a>
          </div>
        ) : (
          <>
            <form onSubmit={submitNew} className="space-y-4">
              <Field label={t('invite.yourName')} required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
              <Field label={t('password.withMin')} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} />
              <Field label={t('password.repeat')} type="password" autoComplete="new-password" required value={repeat} onChange={e => setRepeat(e.target.value)} />
              <Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('invite.acceptAndSignIn')}</Button>
            </form>
            {info.google && (
              <>
                <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />{t('common.or')}<span className="h-px flex-1 bg-slate-200" /></div>
                <Button variant="secondary" disabled={busy} onClick={() => void google()}>{t('invite.google')}</Button>
              </>
            )}
          </>
        )}
      </Card>
    </Centered>
  );
}
