import { notFound } from 'next/navigation';
import { ResetPassword } from '../../features/auth/ResetPassword';
import { currentSite } from '../../lib/site';

/** Восстановление пароля (5.6) — только для пользователей компаний на app.<домен>. */
export default async function ResetPasswordPage() {
  if ((await currentSite()).kind !== 'app') notFound();
  return <ResetPassword />;
}
