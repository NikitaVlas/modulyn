# Установка Modulyn у клиента

Выделенная установка (Phase 11): свой сервер клиента, свой домен, своя почта, данные — у клиента. Код один для всех клиентов; на сервер попадают только готовые образы нужной версии.
Пример — Nova: CRM `crm.bjjmoenchengladbach.de`, вход `login.crm.bjjmoenchengladbach.de`, платформа (только вы) `admin.crm.bjjmoenchengladbach.de`.
Обслуживание после установки — [operations.md](operations.md), раздел 7. Договорённости с клиентом — [client-checklist.md](client-checklist.md).

Кто что делает: заказ сервера, DNS, почтовый ящик, хранилище копий — в аккаунтах **клиента** (он оплачивает, вы получаете доступ). Всё остальное — вы.

## 0. Один раз у себя: выпуск версии

Образы хранятся в **закрытом** хранилище образов, например GitHub Container Registry вашего репозитория.

```bash
docker login ghcr.io -u <ваш GitHub-логин>
```

Пароль — персональный токен GitHub с правом `write:packages`.

```bash
MODULYN_REGISTRY=ghcr.io/<ваш GitHub-логин> pnpm release 0.11.0 --push
```

Выпускайте из закоммиченного состояния (скрипт предупредит о незакоммиченных изменениях). Номер версии не переиспользуйте: следующая — `0.11.1`, `0.12.0` и т. д.

## 1. Сервер (VPS клиента)

Требования: Linux (Debian 12 или Ubuntu 24.04), 2 vCPU, 4 ГБ RAM, от 40 ГБ диска, **в ЕС**. Заказывает клиент на свой аккаунт; ваш открытый SSH-ключ добавляется при заказе или клиентом.

На сервере (под пользователем с sudo):

1. Обновления и защита: `sudo apt update && sudo apt -y upgrade`, автоматические обновления безопасности `sudo apt -y install unattended-upgrades`.
2. Вход только по ключу: в `/etc/ssh/sshd_config` — `PasswordAuthentication no`, `PermitRootLogin no`, затем `sudo systemctl restart ssh` (проверьте вход по ключу во втором окне **до** закрытия первого).
3. Брандмауэр: открыть только 22, 80, 443 — `sudo ufw allow 22,80,443/tcp && sudo ufw enable`.
4. Docker из официального репозитория: https://docs.docker.com/engine/install/ (раздел для вашего дистрибутива), затем `sudo usermod -aG docker $USER` и перезайти.
5. Доступ к образам (только чтение): `docker login ghcr.io -u <логин>` с токеном GitHub с правом `read:packages` (отдельный токен на клиента — его можно отозвать).

## 2. DNS (у регистратора домена клиента)

Три записи **A** на IP сервера (и **AAAA**, если у сервера есть IPv6):

| Имя | Тип | Значение |
|---|---|---|
| `crm` | A | IP сервера |
| `login.crm` | A | IP сервера |
| `admin.crm` | A | IP сервера |

Проверка: `nslookup crm.bjjmoenchengladbach.de` возвращает IP сервера (может занять до часа).

## 3. Почта (E7)

Почтовый ящик на домене клиента, например `crm@bjjmoenchengladbach.de` (у Strato — в разделе почты). Нужны: SMTP-сервер, порт, логин и пароль ящика. Для домена у почтового провайдера должны быть настроены SPF и DKIM (у Strato для своих ящиков — обычно по умолчанию).

## 4. Ключ шифрования копий и хранилище (E9)

1. **У себя** создайте пару ключей age (один раз на клиента):

   ```bash
   docker run --rm --entrypoint age-keygen ghcr.io/<логин>/modulyn-backup:0.11.0 > nova-backup-key.txt
   ```

   Файл содержит **закрытый** ключ (`AGE-SECRET-KEY-…`) — сохраните его в менеджере паролей; на сервер он не попадает. Открытый ключ (`age1…`) — в строке `# public key:` этого файла.
2. Хранилище вне сервера у клиента: любое, что поддерживает rclone (S3-совместимое в ЕС, Strato HiDrive по WebDAV/SFTP и т. п.). Настройка — переменными `RCLONE_CONFIG_OFFSITE_*` в `.env` по документации rclone для выбранного типа (https://rclone.org/docs/#config-file — раздел «Environment variables»). Пример для WebDAV: `RCLONE_CONFIG_OFFSITE_TYPE=webdav`, `…_URL=https://webdav.hidrive.strato.com/users/<логин>`, `…_VENDOR=other`, `…_USER=…`, `…_PASS=<пароль в виде rclone obscure>`.
3. Наблюдение (E10), по желанию, но рекомендуется: бесплатная проверка в сервисе вроде healthchecks.io — адрес проверки в `BACKUP_PING_URL` (успех ночной копии — сигнал «жив», ошибка или диск > 85 % — сигнал тревоги), плюс внешняя проверка `https://crm.…/api/health/ready` раз в несколько минут с уведомлением вам.

## 5. Установка

```bash
mkdir -p ~/modulyn/brand && cd ~/modulyn
```

Скопируйте сюда `deploy/docker-compose.yml` и `deploy/Caddyfile` из репозитория (например `scp`). Затем создайте `.env` (пароли и ключи — случайные, на экран не выводятся):

```bash
docker run --rm -v "$PWD:/out" ghcr.io/<логин>/modulyn-migrate:0.11.0 node apps/api/scripts/server-env.mjs --out /out/.env --crm crm.bjjmoenchengladbach.de --login login.crm.bjjmoenchengladbach.de --admin admin.crm.bjjmoenchengladbach.de --company nova --acme-email <ваш email> --registry ghcr.io/<логин> --version 0.11.0
```

Откройте `.env` (`nano .env`) и заполните строки TODO:

- `SMTP_URL` — например `smtps://crm%40bjjmoenchengladbach.de:<пароль>@smtp.strato.de:465` (символ `@` в логине — как `%40`);
- `MAIL_FROM` — например `Nova CRM <crm@bjjmoenchengladbach.de>`;
- `BACKUP_AGE_RECIPIENT` — открытый ключ `age1…`; `RCLONE_CONFIG_OFFSITE_*` — хранилище; `BACKUP_PING_URL` — по желанию;
- бренд (по желанию): `BRAND_NAME=Nova CRM`, `BRAND_COLOR=#RRGGBB`, логотип — файл в `~/modulyn/brand/logo.svg` и `BRAND_LOGO_URL=/brand/logo.svg`.

Скопируйте `PLATFORM_TOTP_KEY` из `.env` в менеджер паролей (рядом с ключом копий).

Запуск:

```bash
chmod 600 .env && docker compose up -d --wait
```

Caddy сам получит сертификаты для трёх адресов (DNS из шага 2 должен уже указывать на сервер). Проверка:

```bash
curl -s https://crm.bjjmoenchengladbach.de/api/health/ready
```

Ответ: `{"status":"ready","database":"up"}`.

## 6. Первые шаги в системе

1. Администратор платформы (вы):

   ```bash
   docker compose run --rm migrate node apps/api/scripts/platform-admin.mjs create --email <ваш email> --name "<имя>"
   ```

   Временный пароль печатается один раз. Вход на `https://admin.crm.…`: свой пароль, затем второй фактор (QR-код, коды восстановления — в менеджер паролей).
2. «Unternehmen» → «Neues Unternehmen»: **поддомен — ровно `nova`** (как в `TENANT_HOSTS`), название, имя в интерфейсе, email и имя администратора клиента. Он получит приглашение на `https://login.crm.…`.
3. Проверка копий: `docker compose run --rm backup node apps/api/scripts/offsite-backup.mjs once` — копия появилась в хранилище; у себя расшифруйте её и проверьте восстановление (раздел 7.3 в operations.md).

## 7. Подключение сайта клиента (Nova)

1. Администратор Nova → «Anfragen-Eingang» → «Neuer Eingangspunkt»: «Vom Website-Server», тип `trial`, доп. поле `program = Programm`. Скопировать адрес приёма и секрет.
2. На сервере сайта (Strato) в `api/config.php`: `CRM_INGEST_URL` — адрес приёма (`https://crm.bjjmoenchengladbach.de/api/webhooks/forms/<ключ>`), `CRM_INGESTION_SECRET` — секрет ([integrations/web-forms.md](integrations/web-forms.md), раздел 4).
3. Пробная заявка с сайта → она в «Anfragen», журнал приёма — «Angenommen»; письма сайта приходят как раньше.

Откат подключения: очистить `CRM_INGEST_URL` — сайт работает без CRM, как раньше.
