import type { Entry } from '../entry.js';

/** Общие слова интерфейса, навигация, роли, ошибки клиента API. */
export const common = {
  'common.loading': { de: 'Wird geladen…', en: 'Loading…', ru: 'Загрузка…' },
  'common.save': { de: 'Speichern', en: 'Save', ru: 'Сохранить' },
  'common.saving': { de: 'Wird gespeichert…', en: 'Saving…', ru: 'Сохранение…' },
  'common.sending': { de: 'Wird gesendet…', en: 'Sending…', ru: 'Отправка…' },
  'common.cancel': { de: 'Abbrechen', en: 'Cancel', ru: 'Отмена' },
  'common.close': { de: 'Schließen', en: 'Close', ru: 'Закрыть' },
  'common.back': { de: 'Zurück', en: 'Back', ru: 'Назад' },
  'common.forward': { de: 'Weiter', en: 'Next', ru: 'Вперёд' },
  'common.done': { de: 'Fertig', en: 'Done', ru: 'Готово' },
  'common.continue': { de: 'Weiter', en: 'Continue', ru: 'Продолжить' },
  'common.copy': { de: 'Kopieren', en: 'Copy', ru: 'Копировать' },
  'common.copied': { de: 'Kopiert', en: 'Copied', ru: 'Скопировано' },
  'common.edit': { de: 'Bearbeiten', en: 'Edit', ru: 'Изменить' },
  'common.enable': { de: 'Aktivieren', en: 'Enable', ru: 'Включить' },
  'common.disable': { de: 'Deaktivieren', en: 'Disable', ru: 'Отключить' },
  'common.email': { de: 'E-Mail', en: 'Email', ru: 'Email' },
  'common.name': { de: 'Name', en: 'Name', ru: 'Имя' },
  'common.phone': { de: 'Telefon', en: 'Phone', ru: 'Телефон' },
  'common.password': { de: 'Passwort', en: 'Password', ru: 'Пароль' },
  'common.or': { de: 'oder', en: 'or', ru: 'или' },
  'common.signIn': { de: 'Anmelden', en: 'Sign in', ru: 'Войти' },
  'common.signingIn': { de: 'Anmeldung…', en: 'Signing in…', ru: 'Вход…' },
  'common.signOut': { de: 'Abmelden', en: 'Sign out', ru: 'Выйти' },
  'common.confirm': { de: 'Bestätigen', en: 'Confirm', ru: 'Подтвердить' },
  'common.checking': { de: 'Wird geprüft…', en: 'Checking…', ru: 'Проверка…' },
  'common.actionFailed': { de: 'Die Aktion ist fehlgeschlagen', en: 'The action failed', ru: 'Не удалось выполнить действие' },
  'common.serviceDown': {
    de: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte laden Sie die Seite später neu.',
    en: 'The service is temporarily unavailable. Please reload the page later.',
    ru: 'Сервис временно недоступен. Обновите страницу позже.',
  },
  'common.serviceDownRetry': {
    de: 'Der Dienst ist vorübergehend nicht verfügbar. Bitte versuchen Sie es später erneut.',
    en: 'The service is temporarily unavailable. Please try again later.',
    ru: 'Сервис временно недоступен. Попробуйте позже.',
  },
  'common.notFound': { de: 'Seite nicht gefunden', en: 'Page not found', ru: 'Страница не найдена' },
  'common.adminOnly': {
    de: 'Dieser Bereich steht nur Administratoren des Unternehmens zur Verfügung.',
    en: 'This section is only available to company administrators.',
    ru: 'Раздел доступен только администратору компании.',
  },
  'common.language': { de: 'Sprache', en: 'Language', ru: 'Язык' },

  'role.TENANT_ADMIN': { de: 'Administrator', en: 'Administrator', ru: 'Администратор' },
  'role.MANAGER': { de: 'Mitarbeiter', en: 'Manager', ru: 'Менеджер' },

  'nav.home': { de: 'Startseite', en: 'Home', ru: 'Главная' },
  'nav.leads': { de: 'Anfragen', en: 'Leads', ru: 'Заявки' },
  'nav.intake': { de: 'Anfragen-Eingang', en: 'Lead intake', ru: 'Приём заявок' },
  'nav.users': { de: 'Benutzer', en: 'Users', ru: 'Пользователи' },
  'nav.switchCompany': { de: 'Unternehmen wechseln', en: 'Switch company', ru: 'Сменить компанию' },
  'nav.password': { de: 'Passwort', en: 'Password', ru: 'Пароль' },

  'client.generic': {
    de: 'Die Anfrage an den Server ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
    en: 'The request failed. Please try again.',
    ru: 'Не удалось выполнить запрос. Попробуйте ещё раз.',
  },
  'client.sessionEnded': {
    de: 'Ihre Sitzung ist beendet. Laden Sie die Seite neu, um sich erneut anzumelden.',
    en: 'Your session has ended. Reload the page to sign in again.',
    ru: 'Сеанс завершён. Обновите страницу, чтобы войти снова.',
  },
  'client.forbidden': {
    de: 'Sie haben keine Berechtigung für diese Aktion.',
    en: 'You do not have permission for this action.',
    ru: 'Недостаточно прав для этого действия.',
  },
  'client.unavailable': {
    de: 'Der Dienst ist vorübergehend nicht verfügbar. Versuchen Sie es in einer Minute erneut – Ihre Eingaben bleiben erhalten.',
    en: 'The service is temporarily unavailable. Try again in a minute — your input has been kept.',
    ru: 'Сервис временно недоступен. Попробуйте через минуту — введённые данные не потеряны.',
  },
  'client.moduleDisabled': {
    de: 'Dieser Bereich ist für Ihr Unternehmen deaktiviert. Wenden Sie sich an Ihren Administrator.',
    en: 'This section is disabled for your company. Contact your administrator.',
    ru: 'Раздел отключён для вашей компании. Обратитесь к администратору.',
  },
  'client.offline': {
    de: 'Keine Verbindung zum Server. Prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.',
    en: 'No connection to the server. Check your internet connection and try again.',
    ru: 'Нет связи с сервером. Проверьте подключение к интернету и попробуйте ещё раз.',
  },

  'landing.title': { de: 'Die Grundlage für Ihr CRM.', en: 'The foundation for your CRM.', ru: 'Основа для вашей CRM.' },
  'landing.text': {
    de: 'Eine Plattform für unabhängige Teams. Benutzer, Daten und Module jedes Unternehmens liegen in einem eigenen Bereich.',
    en: 'One platform for independent teams. Each company’s users, data and modules live in their own space.',
    ru: 'Одна платформа для независимых команд. Пользователи, данные и модули каждой компании — в своём пространстве.',
  },
  'meta.description': { de: 'Modulare CRM-Plattform', en: 'Modular CRM platform', ru: 'Модульная CRM-платформа' },
} satisfies Record<string, Entry>;
