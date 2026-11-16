import { notFound } from 'next/navigation';
import { PasswordForm } from '../../features/auth/PasswordForm';
import { currentSite } from '../../lib/site';

export default async function PasswordPage() {
  if ((await currentSite()).kind === 'unknown') notFound();
  return <PasswordForm />;
}
