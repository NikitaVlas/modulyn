import type { MailMessage } from './mail.service.js';

/**
 * Тексты писем (C9: язык интерфейса — русский). Только имя компании, имя приглашающего и ссылка;
 * никаких других персональных данных. Каждое письмо — и текстовая, и HTML-версия.
 */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function html(title: string, paragraphs: string[], link: string, button: string, footer: string): string {
  return `<!doctype html><html lang="ru"><body style="margin:0;background:#f5f6f2;font-family:Arial,Helvetica,sans-serif;color:#17272c">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:12px;letter-spacing:3px;font-weight:bold;color:#115e59">MODULYN</p>
<h1 style="font-size:22px">${escape(title)}</h1>
${paragraphs.map(p => `<p style="line-height:1.6">${escape(p)}</p>`).join('\n')}
<p style="margin:28px 0"><a href="${escape(link)}" style="background:#115e59;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escape(button)}</a></p>
<p style="font-size:13px;color:#555;line-height:1.6">Если кнопка не работает, откройте ссылку:<br><span style="word-break:break-all">${escape(link)}</span></p>
<p style="font-size:13px;color:#555;line-height:1.6">${escape(footer)}</p>
</div></body></html>`;
}

export function invitationMail(input: { to: string; companyName: string; inviterName: string | null; link: string }): MailMessage {
  const who = input.inviterName ? `${input.inviterName} приглашает вас` : 'Вас приглашают';
  const title = `Приглашение в ${input.companyName}`;
  const lines = [`${who} в ${input.companyName}.`, 'Ссылка действует 7 дней и подходит один раз.'];
  const footer = 'Если вы не ждали этого письма, просто проигнорируйте его.';
  return {
    to: input.to, subject: title,
    text: `${title}\n\n${lines.join('\n')}\n\nПринять приглашение: ${input.link}\n\n${footer}\n`,
    html: html(title, lines, input.link, 'Принять приглашение', footer),
  };
}

export function passwordResetMail(input: { to: string; link: string }): MailMessage {
  const title = 'Восстановление пароля';
  const lines = ['Кто-то запросил смену пароля для вашего аккаунта Modulyn.', 'Ссылка действует 1 час и подходит один раз. После смены пароля все ваши сеансы будут завершены.'];
  const footer = 'Если вы не запрашивали смену пароля, проигнорируйте письмо — пароль останется прежним.';
  return {
    to: input.to, subject: title,
    text: `${title}\n\n${lines.join('\n')}\n\nЗадать новый пароль: ${input.link}\n\n${footer}\n`,
    html: html(title, lines, input.link, 'Задать новый пароль', footer),
  };
}
