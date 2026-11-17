# Приём заявок с сайтов (Phase 8)

Любой сайт компании — PHP, WordPress, React, Next.js, Tilda, статический HTML — может отправлять заявки в Modulyn.
Технология сайта не важна: нужен один HTTP-запрос `POST` с JSON. Каждая принятая заявка появляется в разделе
«Заявки» компании со статусом «Новая», источником «Форма сайта» и первой записью в истории.

## 1. Создать точку приёма

Администратор компании: меню **«Приём заявок»** → **«Новая точка приёма»**.

| Поле | Что указать |
|---|---|
| Название | Для себя, например «Сайт, пробная тренировка» |
| Тип заявки | Необязательно. Латиница без пробелов, например `trial`. Видно в карточке заявки и в фильтрах |
| Как сайт отправляет | **С сервера сайта** (рекомендуется) или **Из браузера** — см. ниже |
| Дополнительные поля | Поля формы, которые нужно сохранить в сообщении заявки: `program = Программа` |

После создания Modulyn показывает:

- **адрес приёма** — `https://<компания>.<домен>/api/webhooks/forms/<ключ>`;
- **секрет** (только режим «С сервера сайта») — **один раз**. В Modulyn хранится лишь его отпечаток.
  Потерянный секрет не восстановить — кнопка «Новый секрет» выпускает новый, старый перестаёт работать сразу.

Точку можно отключить: сайт будет получать `404`, заявки не создаются. Отключение модуля «Заявки» у компании
закрывает все её точки так же.

## 2. Формат запроса

```
POST https://<компания>.<домен>/api/webhooks/forms/<ключ>
Content-Type: application/json
X-CRM-Integration-Key: <секрет>          ← или: Authorization: Bearer <секрет>

{
  "submissionId": "3f9c…",               ← необязательно, 8–128 символов [A-Za-z0-9_-]: защита от дублей
  "name": "Anna Muster",                 ← или firstName + lastName
  "email": "anna@example.de",            ← нужен email ИЛИ телефон
  "phone": "+49 171 0000000",
  "message": "Текст из формы",
  "program": "Kinder 4–6"                 ← дополнительное поле, если настроено
}
```

Распознаются сами: `name`, `firstName`, `lastName`, `email`, `phone`, `message`. Другие имена полей можно
сопоставить в настройке точки (`fieldMapping.fields`, через API). Неизвестные поля без настройки игнорируются.

Ограничения: тело до 32 КБ; имя до 200 символов, email до 320, телефон 3–50 символов (цифры, `+ ( ) - . /`),
сообщение до 5000; не больше 60 запросов в минуту на точку.

### Ответы

| Код | Тело | Значение |
|---|---|---|
| 202 | `{"ok":true}` | Заявка создана |
| 202 | `{"ok":true,"duplicate":true}` | Такая отправка уже принята — новая заявка не создана |
| 400 | `{"ok":false,"error":"VALIDATION","field":"email","reason":"invalid"}` | Данные не подходят; `reason`: `required`, `invalid`, `too_long`, `contact_required`, `json_object_required` |
| 401 | `{"ok":false,"error":"UNAUTHORIZED"}` | Неверный или отсутствующий секрет |
| 403 | `{"ok":false,"error":"ORIGIN_NOT_ALLOWED"}` | Режим «Из браузера»: запрос не с разрешённого сайта |
| 404 | `{"ok":false,"error":"NOT_FOUND"}` | Ключ неизвестен в этой компании, точка или модуль отключены |
| 413 | `{"ok":false,"error":"TOO_LARGE"}` | Тело больше 32 КБ |
| 429 | `{"ok":false,"error":"RATE_LIMITED"}` | Слишком часто; заголовок `Retry-After` |
| 503 | `{"ok":false,"error":"UNAVAILABLE"}` | Временная ошибка — можно повторить с тем же `submissionId` |

### Дубли

Если сайт передаёт `submissionId` (или заголовок `Idempotency-Key`), повтор с тем же ключом не создаёт вторую заявку —
сайт может спокойно повторять запрос после сетевой ошибки. Без ключа дублем считается отправка с тем же именем,
email, телефоном и сообщением в течение тех же суток (UTC).

### Журнал

В разделе «Приём заявок» — последние 100 отправок: время, точка, результат («Принята», «Дубль», «Отклонена» с причиной)
и ссылка на созданную заявку. **Содержимое форм в журнале не хранится** — данные посетителя есть только в самой заявке.

## 3. Примеры

### PHP (сервер сайта, в т.ч. WordPress)

```php
<?php
function modulyn_send_lead(array $form): bool {
    $payload = [
        'submissionId' => bin2hex(random_bytes(16)),
        'name'    => trim(($form['firstName'] ?? '') . ' ' . ($form['lastName'] ?? '')),
        'email'   => $form['email'] ?? '',
        'phone'   => $form['phone'] ?? '',
        'message' => $form['message'] ?? '',
    ];
    $ch = curl_init(MODULYN_INTAKE_URL);                 // адрес приёма из настройки
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-CRM-Integration-Key: ' . MODULYN_SECRET],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 8,
    ]);
    curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $status >= 200 && $status < 300;
}
```

Секрет храните в конфигурации сервера (вне публичной папки и вне git), а не в коде страницы.

### Node.js / Next.js (route handler или server action)

```js
export async function sendLead(form) {
  const r = await fetch(process.env.MODULYN_INTAKE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MODULYN_SECRET}` },
    body: JSON.stringify({ submissionId: crypto.randomUUID().replaceAll('-', ''), ...form }),
    signal: AbortSignal.timeout(8000),
  });
  return r.status === 202;
}
```

### Из браузера (статический сайт без сервера)

Режим «Из браузера»: секрета нет (его нельзя спрятать в JavaScript страницы). Вместо него Modulyn принимает запросы
только с адресов сайта, указанных в точке (`https://example.com`), ограничивает частоту с одного посетителя
(10 в минуту) и отбрасывает ботов по скрытому полю `website` (или `_hp`): человек его не видит и не заполняет.

```html
<form id="lead">
  <input name="name" required> <input name="email" type="email"> <input name="phone">
  <textarea name="message"></textarea>
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
  <button>Отправить</button>
</form>
<script>
document.getElementById('lead').addEventListener('submit', async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  data.submissionId = crypto.randomUUID().replaceAll('-', '');
  const r = await fetch('https://<компания>.<домен>/api/webhooks/forms/<ключ>', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  alert(r.status === 202 ? 'Спасибо! Мы свяжемся с вами.' : 'Не удалось отправить, попробуйте позже.');
});
</script>
```

Если есть возможность отправлять с сервера — выбирайте режим «С сервера сайта»: он надёжнее.

## 4. Сайт Nova (bjjmoenchengladbach.de)

Сайт уже содержит клиент CRM (`api/trial-crm.php`): после сохранения заявки на пробную тренировку он отправляет
`POST` JSON с заголовком `X-CRM-Integration-Key` и полями `submissionId, firstName, lastName, email, phone, program, message`.
Modulyn принимает этот запрос **без изменений кода сайта** — это проверено интеграционным тестом с точно таким запросом.

Подключение — **после развёртывания Modulyn в интернете** (решение W10):

1. В CRM Nova: «Приём заявок» → «Новая точка приёма»: режим «С сервера сайта», тип заявки `trial`,
   дополнительное поле `program = Программа`. Скопировать адрес приёма и секрет.
2. На сервере сайта в `api/config.php` (файл с секретами, не в git) заполнить:
   - `CRM_INGEST_URL` — адрес приёма, `https://nova.<домен>/api/webhooks/forms/<ключ>`;
   - `CRM_INGESTION_SECRET` — секрет.
3. Отправить пробную заявку с сайта и убедиться, что она появилась в «Заявках» и в журнале приёма — «Принята».

Сайт считает успехом любой ответ 2xx; при ошибке он сохраняет заявку у себя, как и раньше, — посетитель
в любом случае видит подтверждение.

Локально (без сайта) тот же запрос проверяет `pnpm smoke` на точке из `pnpm db:seed` — `nova-local-trial-endpoint`.
