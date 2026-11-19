import { translate, type Locale, type MessageKey, type Params } from '@modulyn/i18n';
import type { MailMessage } from './mail.service.js';

/**
 * Тексты писем (Phase 10, I4): язык письма передаётся явно — это язык получателя (сброс пароля)
 * или пригласившего (приглашение), а не язык текущего запроса. Только имя компании, имя приглашающего
 * и ссылка; никаких других персональных данных. Каждое письмо — и текстовая, и HTML-версия.
 */
function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function html(locale: Locale, title: string, paragraphs: string[], link: string, button: string, footer: string): string {
  return `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f5f6f2;font-family:Arial,Helvetica,sans-serif;color:#17272c">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:12px;letter-spacing:3px;font-weight:bold;color:#115e59">MODULYN</p>
<h1 style="font-size:22px">${escape(title)}</h1>
${paragraphs.map(p => `<p style="line-height:1.6">${escape(p)}</p>`).join('\n')}
<p style="margin:28px 0"><a href="${escape(link)}" style="background:#115e59;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${escape(button)}</a></p>
<p style="font-size:13px;color:#555;line-height:1.6">${escape(translate(locale, 'mail.linkFallback'))}<br><span style="word-break:break-all">${escape(link)}</span></p>
<p style="font-size:13px;color:#555;line-height:1.6">${escape(footer)}</p>
</div></body></html>`;
}

function build(locale: Locale, to: string, link: string, keys: { title: MessageKey; lines: MessageKey[]; button: MessageKey; footer: MessageKey }, params: Params): MailMessage {
  const tr = (key: MessageKey) => translate(locale, key, params);
  const title = tr(keys.title);
  const lines = keys.lines.map(tr);
  const button = tr(keys.button);
  const footer = tr(keys.footer);
  return {
    to, subject: title,
    text: `${title}\n\n${lines.join('\n')}\n\n${button}: ${link}\n\n${footer}\n`,
    html: html(locale, title, lines, link, button, footer),
  };
}

export function invitationMail(input: { to: string; companyName: string; inviterName: string | null; link: string; locale: Locale }): MailMessage {
  return build(input.locale, input.to, input.link, {
    title: 'mail.inviteTitle', lines: [input.inviterName ? 'mail.inviteBy' : 'mail.inviteAnon', 'mail.inviteValidity'],
    button: 'mail.inviteButton', footer: 'mail.inviteFooter',
  }, { company: input.companyName, inviter: input.inviterName ?? '' });
}

export function passwordResetMail(input: { to: string; link: string; locale: Locale }): MailMessage {
  return build(input.locale, input.to, input.link, {
    title: 'mail.resetTitle', lines: ['mail.resetLine1', 'mail.resetLine2'], button: 'mail.resetButton', footer: 'mail.resetFooter',
  }, {});
}
