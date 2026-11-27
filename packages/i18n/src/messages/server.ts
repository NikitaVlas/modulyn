import type { Entry } from '../entry.js';

/** Сообщения API (I5), служебные страницы перехода и письма (I4). */
export const server = {
  // ───── Вход и аккаунт ─────
  'err.invalidCredentials': { de: 'E-Mail oder Passwort ist falsch', en: 'Incorrect email or password', ru: 'Неверный email или пароль' },
  'err.fieldInvalid': { de: 'Das Feld {field} ist ungültig', en: 'The field {field} is invalid', ru: 'Поле {field} заполнено неверно' },
  'err.signInAgain': { de: 'Bitte melden Sie sich erneut an', en: 'Please sign in again', ru: 'Войдите заново' },
  'err.invalidCode': { de: 'Falscher Code', en: 'Incorrect code', ru: 'Неверный код' },
  'err.mfaAlreadySet': {
    de: 'Die Zwei-Faktor-Authentifizierung ist bereits eingerichtet',
    en: 'Two-factor authentication is already set up',
    ru: 'Второй фактор уже настроен',
  },
  'err.mfaStartFirst': { de: 'Starten Sie zuerst die Einrichtung', en: 'Start the setup first', ru: 'Сначала начните настройку' },
  'err.mfaCodeMismatch': {
    de: 'Der Code passt nicht. Prüfen Sie die Uhrzeit auf Ihrem Telefon und geben Sie einen neuen Code ein.',
    en: 'The code does not match. Check the time on your phone and enter a new code.',
    ru: 'Код не подходит. Проверьте время на телефоне и введите новый код.',
  },
  'err.passwordSame': {
    de: 'Das neue Passwort entspricht dem aktuellen',
    en: 'The new password is the same as the current one',
    ru: 'Новый пароль совпадает с текущим',
  },
  'err.passwordCurrentWrong': { de: 'Das aktuelle Passwort ist falsch', en: 'The current password is incorrect', ru: 'Текущий пароль указан неверно' },
  'err.passwordTooShort': {
    de: 'Das Passwort muss mindestens {min} Zeichen lang sein',
    en: 'The password must be at least {min} characters long',
    ru: 'Пароль должен содержать не меньше {min} символов',
  },
  'err.passwordTooLong': {
    de: 'Das Passwort darf höchstens {max} Zeichen lang sein',
    en: 'The password must be at most {max} characters long',
    ru: 'Пароль должен содержать не больше {max} символов',
  },
  'err.passwordBlank': {
    de: 'Das Passwort darf nicht nur aus Leerzeichen bestehen',
    en: 'The password cannot consist only of spaces',
    ru: 'Пароль не может состоять из пробелов',
  },
  'err.emailInvalid': { de: 'Geben Sie eine gültige E-Mail-Adresse ein', en: 'Enter a valid email address', ru: 'Укажите корректный email' },
  'err.tooManyRequests': {
    de: 'Zu viele Versuche. Bitte versuchen Sie es später erneut.',
    en: 'Too many attempts. Please try again later.',
    ru: 'Слишком много запросов. Попробуйте позже.',
  },
  'err.tooManyLogins': {
    de: 'Zu viele Anmeldeversuche. Bitte versuchen Sie es später erneut.',
    en: 'Too many sign-in attempts. Please try again later.',
    ru: 'Слишком много попыток входа. Попробуйте позже.',
  },
  'err.linkInvalid': { de: 'Der Link ist ungültig oder abgelaufen', en: 'The link is invalid or has expired', ru: 'Ссылка недействительна или устарела' },
  'err.linkInvalidRequestNew': {
    de: 'Der Link ist ungültig oder abgelaufen. Fordern Sie einen neuen an.',
    en: 'The link is invalid or has expired. Request a new one.',
    ru: 'Ссылка недействительна или устарела. Запросите новую.',
  },
  'err.moduleDisabled': {
    de: 'Dieser Bereich ist für Ihr Unternehmen deaktiviert',
    en: 'This section is disabled for your company',
    ru: 'Раздел отключён для вашей компании',
  },
  'err.inviteLinkInvalid': {
    de: 'Der Link ist ungültig oder abgelaufen. Bitten Sie den Administrator, die Einladung erneut zu senden.',
    en: 'The link is invalid or has expired. Ask the administrator to send the invitation again.',
    ru: 'Ссылка недействительна или устарела. Попросите администратора отправить приглашение ещё раз.',
  },
  'err.inviteOtherEmail': {
    de: 'Die Einladung wurde an eine andere E-Mail-Adresse gesendet. Melden Sie sich ab und mit dem richtigen Konto an.',
    en: 'The invitation was sent to a different email address. Sign out and sign in with the right account.',
    ru: 'Приглашение отправлено на другой email. Выйдите и войдите нужным аккаунтом.',
  },
  'err.inviteHasAccount': {
    de: 'Sie haben bereits ein Konto. Melden Sie sich an, um die Einladung anzunehmen.',
    en: 'You already have an account. Sign in to accept the invitation.',
    ru: 'У вас уже есть аккаунт. Войдите, чтобы принять приглашение.',
  },
  'err.nameTooLong': { de: 'Der Name ist länger als 200 Zeichen', en: 'The name is longer than 200 characters', ru: 'Имя длиннее 200 символов' },
  'err.localeInvalid': { de: 'Unbekannte Sprache', en: 'Unknown language', ru: 'Неизвестный язык' },
  'err.badRequest': { de: 'Ungültige Eingabe', en: 'Invalid request', ru: 'Некорректный запрос' },
  'err.statusInvalid': { de: 'Ungültiger Status', en: 'Invalid status', ru: 'Некорректный статус' },

  // ───── Приём заявок ─────
  'err.originsMax': { de: 'Höchstens 10 erlaubte Adressen', en: 'At most 10 allowed addresses', ru: 'Разрешённых адресов — не больше 10' },
  'err.originInvalid': { de: 'Ungültige Website-Adresse: {value}', en: 'Invalid website address: {value}', ru: 'Некорректный адрес сайта: {value}' },
  'err.originHttps': {
    de: 'Die Website-Adresse muss mit https:// beginnen',
    en: 'The website address must start with https://',
    ru: 'Адрес сайта должен начинаться с https://',
  },
  'err.originNoPath': {
    de: 'Geben Sie nur die Adresse der Website an, ohne Pfad: https://example.com',
    en: 'Enter only the website address, without a path: https://example.com',
    ru: 'Укажите только адрес сайта, без пути: https://example.com',
  },
  'err.endpointName': { de: 'Bezeichnung: 1 bis 100 Zeichen', en: 'Name: 1 to 100 characters', ru: 'Название — от 1 до 100 символов' },
  'err.endpointMode': {
    de: 'Wählen Sie den Modus: vom Website-Server oder aus dem Browser',
    en: 'Choose the mode: from the website server or from the browser',
    ru: 'Выберите режим: с сервера сайта или из браузера',
  },
  'err.endpointOriginRequired': {
    de: 'Geben Sie für das Senden aus dem Browser die Adresse der Website an',
    en: 'For sending from the browser, enter the website address',
    ru: 'Для отправки из браузера укажите адрес сайта',
  },
  'err.endpointImmutable': {
    de: 'Modus und Schlüssel eines Eingangspunkts lassen sich nicht ändern – legen Sie einen neuen an',
    en: 'The mode and key of an intake endpoint cannot be changed — create a new one',
    ru: 'Режим и ключ точки не меняются — создайте новую точку',
  },
  'err.browserNoSecret': {
    de: 'Ein Eingangspunkt für den Browser hat keinen Geheimschlüssel',
    en: 'A browser intake endpoint has no secret',
    ru: 'У точки для браузера нет секрета',
  },
  'err.endpointInvalid': { de: 'Ungültiger Eingangspunkt', en: 'Invalid intake endpoint', ru: 'Некорректная точка приёма' },
  'err.sourceDetail': {
    de: 'Anfragetyp: lateinische Buchstaben, Ziffern, „-“, „_“, bis 50 Zeichen (z. B. trial)',
    en: 'Lead type: Latin letters, digits, “-”, “_”, up to 50 characters (e.g. trial)',
    ru: 'Тип заявки: латиница, цифры, «-», «_», до 50 символов (например trial)',
  },
  'err.mappingInvalid': { de: 'Ungültige Feldzuordnung', en: 'Invalid field mapping', ru: 'Некорректное сопоставление полей' },
  'err.mappingRenames': { de: 'Ungültige Feldumbenennungen', en: 'Invalid field renames', ru: 'Некорректные переименования полей' },
  'err.mappingUnknownField': { de: 'Unbekanntes Anfragefeld: {field}', en: 'Unknown lead field: {field}', ru: 'Неизвестное поле заявки: {field}' },
  'err.mappingSourceName': {
    de: 'Ungültiger Formularfeldname für „{field}“',
    en: 'Invalid form field name for “{field}”',
    ru: 'Некорректное имя поля формы для «{field}»',
  },
  'err.extraMax': { de: 'Höchstens 20 Zusatzfelder', en: 'At most 20 extra fields', ru: 'Дополнительных полей — не больше 20' },
  'err.extraInvalid': { de: 'Ungültiges Zusatzfeld', en: 'Invalid extra field', ru: 'Некорректное дополнительное поле' },
  'err.extraName': { de: 'Ungültiger Name des Zusatzfelds', en: 'Invalid extra field name', ru: 'Некорректное имя дополнительного поля' },
  'err.extraLabel': {
    de: 'Bezeichnung des Zusatzfelds: 1 bis 50 Zeichen',
    en: 'Extra field label: 1 to 50 characters',
    ru: 'Подпись дополнительного поля — от 1 до 50 символов',
  },

  // ───── Заявки ─────
  'err.paramRepeated': {
    de: 'Ein Listenparameter wurde mehrfach angegeben',
    en: 'A list parameter was given more than once',
    ru: 'Параметр списка указан несколько раз',
  },
  'err.filterStatus': { de: 'Unbekannter Status im Filter', en: 'Unknown status in the filter', ru: 'Неизвестный статус в фильтре' },
  'err.filterAssignee': { de: 'Ungültiger Filter für Zuständige', en: 'Invalid assignee filter', ru: 'Некорректный фильтр ответственного' },
  'err.searchTooLong': { de: 'Der Suchbegriff ist zu lang', en: 'The search term is too long', ru: 'Слишком длинный поисковый запрос' },
  'err.sortInvalid': { de: 'Ungültige Sortierung', en: 'Invalid sort order', ru: 'Некорректная сортировка' },
  'err.pageInvalid': { de: 'Ungültige Seitennummer', en: 'Invalid page number', ru: 'Некорректный номер страницы' },
  'err.pageSize': { de: 'Seitengröße: 25, 50 oder 100', en: 'Page size: 25, 50 or 100', ru: 'Размер страницы: 25, 50 или 100' },
  'err.fieldTooLong': {
    de: 'Das Feld {field} ist länger als {max} Zeichen',
    en: 'The field {field} is longer than {max} characters',
    ru: 'Поле {field} длиннее {max} символов',
  },
  'err.nameRequired': { de: 'Geben Sie einen Namen an', en: 'Enter a name', ru: 'Укажите имя' },
  'err.leadEmailInvalid': { de: 'Ungültige E-Mail-Adresse', en: 'Invalid email address', ru: 'Некорректный email' },
  'err.phoneInvalid': { de: 'Ungültige Telefonnummer', en: 'Invalid phone number', ru: 'Некорректный телефон' },
  'err.contactRequired': {
    de: 'Geben Sie eine E-Mail-Adresse oder Telefonnummer an',
    en: 'Enter an email address or phone number',
    ru: 'Укажите email или телефон',
  },
  'err.alreadyInStatus': { de: 'Die Anfrage hat diesen Status bereits', en: 'The lead already has this status', ru: 'Заявка уже в этом статусе' },
  'err.leadChanged': {
    de: 'Die Anfrage wurde inzwischen geändert. Die aktuellen Daten wurden geladen.',
    en: 'The lead has been changed in the meantime. The current data has been loaded.',
    ru: 'Заявку уже изменили. Обновлённые данные загружены.',
  },
  'err.assigneeInvalid': { de: 'Ungültige Person', en: 'Invalid team member', ru: 'Некорректный сотрудник' },
  'err.assigneeInactive': {
    de: 'Zuweisen lassen sich nur aktive Mitarbeiter des Unternehmens',
    en: 'Only active members of the company can be assigned',
    ru: 'Назначить можно только активного сотрудника компании',
  },

  // ───── Сотрудники ─────
  'err.nameRequired200': { de: 'Geben Sie einen Namen an (bis 200 Zeichen)', en: 'Enter a name (up to 200 characters)', ru: 'Укажите имя (до 200 символов)' },
  'err.roleRequired': { de: 'Wählen Sie eine Rolle', en: 'Choose a role', ru: 'Выберите роль' },
  'err.alreadyMember': {
    de: 'Diese Person arbeitet bereits im Unternehmen',
    en: 'This person is already a member of the company',
    ru: 'Этот человек уже работает в компании',
  },
  'err.invitesPerDay': { de: 'Höchstens {count} Einladungen pro Tag', en: 'At most {count} invitations per day', ru: 'Не больше {count} приглашений в сутки' },
  'err.roleInvalid': { de: 'Ungültige Rolle', en: 'Invalid role', ru: 'Некорректная роль' },
  'err.selfChange': {
    de: 'Die eigene Rolle und den eigenen Zugang kann nur ein anderer Administrator ändern',
    en: 'Only another administrator can change your own role and access',
    ru: 'Свою роль и доступ может изменить только другой администратор',
  },
  'err.lastAdmin': {
    de: 'Im Unternehmen muss mindestens ein aktiver Administrator bleiben',
    en: 'The company must keep at least one active administrator',
    ru: 'В компании должен остаться хотя бы один активный администратор',
  },

  // ───── Платформа ─────
  'err.fieldRequired': { de: 'Füllen Sie das Feld „{field}“ aus', en: 'Fill in the “{field}” field', ru: 'Заполните поле «{field}»' },
  'err.fieldTooLong200': {
    de: 'Das Feld „{field}“ ist länger als 200 Zeichen',
    en: 'The “{field}” field is longer than 200 characters',
    ru: 'Поле «{field}» длиннее 200 символов',
  },
  'field.name': { de: 'Name', en: 'Name', ru: 'Название' },
  'field.displayName': { de: 'Anzeigename', en: 'Display name', ru: 'Имя в интерфейсе' },
  'field.adminName': { de: 'Name des Administrators', en: 'Administrator name', ru: 'Имя администратора' },
  'err.slugInvalid': {
    de: 'Subdomain: lateinische Buchstaben, Ziffern und Bindestrich, 1 bis 63 Zeichen, ohne Bindestrich am Anfang oder Ende',
    en: 'Subdomain: Latin letters, digits and hyphens, 1 to 63 characters, no hyphen at the start or end',
    ru: 'Поддомен: латинские буквы, цифры и дефис, от 1 до 63 символов, без дефиса в начале и в конце',
  },
  'err.slugReserved': {
    de: 'Die Subdomain „{slug}“ ist für die Plattform reserviert',
    en: 'The subdomain “{slug}” is reserved by the platform',
    ru: 'Поддомен «{slug}» зарезервирован платформой',
  },
  'err.adminEmailInvalid': {
    de: 'Geben Sie eine gültige E-Mail-Adresse des Administrators ein',
    en: 'Enter a valid administrator email address',
    ru: 'Укажите корректный email администратора',
  },
  'err.slugTaken': { de: 'Die Subdomain „{slug}“ ist bereits vergeben', en: 'The subdomain “{slug}” is already taken', ru: 'Поддомен «{slug}» уже занят' },
  'err.companySuspended': { de: 'Das Unternehmen ist deaktiviert', en: 'The company is suspended', ru: 'Компания отключена' },
  'err.moduleUnknown': { de: 'Unbekanntes Modul', en: 'Unknown module', ru: 'Неизвестный модуль' },
  'err.enabledBoolean': { de: 'Geben Sie enabled: true oder false an', en: 'Specify enabled: true or false', ru: 'Укажите enabled: true или false' },
  'err.moduleMissing': {
    de: 'Das Modul fehlt im Katalog. Wenden Sie die Migrationen an.',
    en: 'The module is missing from the catalogue. Apply the migrations.',
    ru: 'Модуль отсутствует в каталоге. Примените миграции.',
  },
  'err.slugImmutable': {
    de: 'Die Subdomain lässt sich nach dem Anlegen des Unternehmens nicht ändern',
    en: 'The subdomain cannot be changed after the company is created',
    ru: 'Поддомен после создания компании не меняется',
  },

  // ───── Служебные страницы перехода между поддоменами ─────
  'page.redirecting': { de: 'Weiterleitung zu {company}…', en: 'Redirecting to {company}…', ru: 'Переход в {company}…' },
  'page.signInTitle': { de: 'Anmeldung', en: 'Sign in', ru: 'Вход' },

  // ───── Письма ─────
  'mail.inviteTitle': { de: 'Einladung zu {company}', en: 'Invitation to {company}', ru: 'Приглашение в {company}' },
  'mail.inviteBy': { de: '{inviter} lädt Sie zu {company} ein.', en: '{inviter} invites you to {company}.', ru: '{inviter} приглашает вас в {company}.' },
  'mail.inviteAnon': { de: 'Sie wurden zu {company} eingeladen.', en: 'You have been invited to {company}.', ru: 'Вас приглашают в {company}.' },
  'mail.inviteValidity': {
    de: 'Der Link ist 7 Tage gültig und kann einmal verwendet werden.',
    en: 'The link is valid for 7 days and can be used once.',
    ru: 'Ссылка действует 7 дней и подходит один раз.',
  },
  'mail.inviteButton': { de: 'Einladung annehmen', en: 'Accept invitation', ru: 'Принять приглашение' },
  'mail.inviteFooter': {
    de: 'Wenn Sie diese E-Mail nicht erwartet haben, ignorieren Sie sie einfach.',
    en: 'If you were not expecting this email, simply ignore it.',
    ru: 'Если вы не ждали этого письма, просто проигнорируйте его.',
  },
  'mail.resetTitle': { de: 'Passwort zurücksetzen', en: 'Reset your password', ru: 'Восстановление пароля' },
  'mail.resetLine1': {
    de: 'Jemand hat eine Passwortänderung für Ihr Konto bei {brand} angefordert.',
    en: 'Someone requested a password change for your {brand} account.',
    ru: 'Кто-то запросил смену пароля для вашего аккаунта {brand}.',
  },
  'mail.resetLine2': {
    de: 'Der Link ist 1 Stunde gültig und kann einmal verwendet werden. Nach der Änderung werden alle Ihre Sitzungen beendet.',
    en: 'The link is valid for 1 hour and can be used once. After the change, all your sessions will be ended.',
    ru: 'Ссылка действует 1 час и подходит один раз. После смены пароля все ваши сеансы будут завершены.',
  },
  'mail.resetButton': { de: 'Neues Passwort festlegen', en: 'Set a new password', ru: 'Задать новый пароль' },
  'mail.resetFooter': {
    de: 'Wenn Sie keine Passwortänderung angefordert haben, ignorieren Sie diese E-Mail – Ihr Passwort bleibt unverändert.',
    en: 'If you did not request a password change, ignore this email — your password stays the same.',
    ru: 'Если вы не запрашивали смену пароля, проигнорируйте письмо — пароль останется прежним.',
  },
  'mail.linkFallback': {
    de: 'Falls die Schaltfläche nicht funktioniert, öffnen Sie diesen Link:',
    en: 'If the button does not work, open this link:',
    ru: 'Если кнопка не работает, откройте ссылку:',
  },
} satisfies Record<string, Entry>;
