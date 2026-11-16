# Modulyn

Модульная multi-tenant CRM. Выполнены Phase 1 (технический каркас), Phase 2 (изоляция компаний: модель данных, миграции, определение компании по поддомену, tenant context, PostgreSQL RLS), Phase 3 (вход по паролю и через Google, выбор и переключение компании, сессии, роли, CSRF, ограничение входа) и Phase 4 (администрирование платформы: создание и отключение компаний, второй фактор для администраторов). Приглашения сотрудников, модули и заявки — следующие фазы. План Phase 4: [specs/phase4_design.md](specs/phase4_design.md). Источник плана, разрешений и статусов: [SPEC.md](SPEC.md); модель данных: [specs/phase2_design.md](specs/phase2_design.md); вход и сессии: [specs/phase3_design.md](specs/phase3_design.md).

## Требования

- Node.js 26.13.0 (версия закреплена в `.node-version`).
- pnpm 12.21.0 (поле `packageManager`). Если установлен другой pnpm, используйте `npx --yes pnpm@12.21.0` вместо `pnpm` во всех командах ниже.
- Docker Engine и Compose; Docker Desktop должен быть запущен на Windows.
- Свободные локальные порты: 8080 (Compose), 5433 (PostgreSQL), 3000 и 3001 (разработка без контейнеров приложений).
- Доступ в интернет при `pnpm install`: Prisma скачивает свой schema engine (нужен для миграций).

## Быстрый запуск в Docker

Из корня проекта:

```sh
pnpm install --frozen-lockfile
pnpm env:init
pnpm stack:up
pnpm db:seed
pnpm smoke
```

`env:init` создаёт `.env` со случайными паролями и не печатает их. Если `.env` уже есть (например, после Phase 1), скрипт только дописывает недостающие переменные. Единственное изменение существующего значения: `DATABASE_URL` со старым суперпользователем переводится на runtime-роль `modulyn_app`, а старое подключение сохраняется как `DATABASE_ADMIN_URL`. `.env` исключён из Git и Docker build context; `.env.example` описывает все переменные.

`stack:up` запускает db → migrate → api, web → proxy. Одноразовый сервис `migrate` создаёт роли БД и применяет миграции; API стартует только после его успешного завершения и подключается как `modulyn_app`. `db:seed` создаёт синтетические компании для проверки — только для локальной среды.

Открыть:

- http://nova.localhost:8080 — CRM компании Nova: без сессии перенаправляет на вход `app.localhost` с заголовком «Вход в Nova CRM».
- http://app.localhost:8080 — центральный вход и выбор компании.
- http://admin.localhost:8080 — вход администратора платформы.
- http://nova.localhost:8080/api/tenant — компания текущего поддомена: `{"slug":"nova","displayName":"Nova CRM"}`.
- http://company-b.localhost:8080/api/tenant — другая компания на том же приложении.
- http://suspended-co.localhost:8080/api/tenant и http://unknown.localhost:8080/api/tenant — одинаковый 404.
- http://nova.localhost:8080/api/health и `/api/health/ready` — liveness и readiness.

Если система не разрешает `*.localhost`, добавьте в hosts `127.0.0.1 nova.localhost company-b.localhost admin.localhost`. Smoke передаёт hostname в заголовке Host, подключаясь к 127.0.0.1, поэтому от DNS не зависит. `SMOKE_ORIGIN` позволяет выбрать другой локальный адрес и порт.

```sh
docker compose ps -a
docker compose logs --tail=100 migrate api web proxy db
pnpm stack:down
```

`stack:down` сохраняет named volume PostgreSQL. Не используйте `docker compose down -v`, если данные нужно сохранить. Изменение `POSTGRES_PASSWORD` в `.env` не меняет пароль уже созданной БД; пароли ролей `modulyn_owner` и `modulyn_app` обновляются автоматически при каждом запуске `migrate` или `pnpm db:roles`.

## Вход и сессии (Phase 3)

Синтетические учётные записи из `pnpm db:seed` (только локально; пароль у всех — `SEED_PASSWORD` в [apps/api/scripts/seed.mjs](apps/api/scripts/seed.mjs)):

| Email | Где | Роль |
| --- | --- | --- |
| `manager@shared.example` | Nova и Company B | менеджер в обеих — для проверки переключения |
| `admin@nova.example` | Nova | администратор компании |
| `admin@company-b.example` | Company B | администратор компании |
| `admin@suspended.example` | только отключённая компания | список компаний пуст |
| `platform@modulyn.example` | `admin.localhost` | администратор платформы (при первом входе — настройка второго фактора) |

Как устроено:

- Пароль вводится только на `app.<домен>` (и `admin.<домен>` для платформы). После входа — список компаний; переход в компанию — одноразовым кодом (60 с), привязанным к браузеру, без кода в URL.
- Cookies `HttpOnly`, без `Domain`: сессия Nova не отправляется на Company B. С https — префикс `__Host-` и `Secure`.
- Access JWT (10 мин, платформа — 5) подписан отдельным ключом для каждого контекста; сессия проверяется в БД на каждом запросе, поэтому выход, блокировка, отключение участия и смена пароля действуют сразу. Refresh-токен меняется при каждом обновлении; повтор старого токена отзывает всю цепочку.
- Изменяющие запросы принимаются только с `Origin` своего хоста и `Content-Type: application/json`. Вход ограничен: 20 попыток с IP и 10 неудачных на аккаунт за 15 минут (HTTP 429).

### Вход через Google

Без настройки кнопка Google скрыта. Чтобы включить:

1. Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → тип **Web application**.
2. Authorized redirect URI: `http://app.localhost:8080/api/auth/google/callback` (для `pnpm dev` — порт 3000). Если Google не примет адрес `app.localhost`, сообщите — предусмотрен запасной вариант (specs/phase3_design.md, раздел «Риски»).
3. Записать Client ID и Client secret в `.env` как `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`, затем `pnpm stack:up`.

Войти через Google может только существующий пользователь: Google-аккаунт привязывается при первом входе, если email подтверждён Google и совпадает с email аккаунта. Регистрации нет.

## Администрирование платформы (Phase 4)

Первого и последующих администраторов платформы создаёт только команда на сервере — публичной регистрации и встроенного пароля нет:

```sh
pnpm platform:admin create --email you@example.com --name "Ваше имя"
```

Команда один раз печатает временный пароль (действует 7 дней). Вход на http://admin.localhost:8080: временный пароль → свой постоянный пароль → обязательная настройка второго фактора (QR-код для приложения-аутентификатора и 10 одноразовых кодов восстановления). Дальше каждый вход — пароль и 6-значный код.

Другие команды: `reset-password` (новый временный пароль), `reset-2fa` (потерян телефон и коды), `block` / `unblock` — все с `--email`. В Docker: `docker compose run --rm migrate node apps/api/scripts/platform-admin.mjs create --email … --name …`.

В разделе «Компании»:

- **Новая компания** — название, имя в интерфейсе, поддомен (после создания не меняется), email и имя первого администратора компании. Если аккаунта с таким email нет, он создаётся, и временный пароль показывается один раз — передайте его человеку; при первом входе он задаёт свой пароль. Если аккаунт есть — человек просто получает доступ к новой компании.
- **Карточка компании** — изменить названия, отключить (поддомен сразу закрыт, все сеансы завершены, данные сохраняются) или включить.
- Администратор платформы видит только настройки компаний и число участников — без заявок, имён и email сотрудников. Все действия записываются в журнал аудита платформы.

`PLATFORM_TOTP_KEY` в `.env` шифрует секреты второго фактора. Не теряйте его: без него всем администраторам платформы придётся заново настроить второй фактор (`reset-2fa`).

## Разработка с перезагрузкой

```sh
pnpm env:init
pnpm infra:up
pnpm db:setup
pnpm db:seed
pnpm dev
```

`pnpm dev` загружает `.env`, собирает contracts и API (включая `prisma generate`), запускает TypeScript watch, перезапуск API и Next.js dev. Открыть http://nova.localhost:3000; Next.js перенаправляет `/api/*` на API :3001. Next.js при этом подменяет Host, поэтому только в этом режиме API принимает исходный hostname из `X-Forwarded-Host` от loopback (`TRUST_DEV_PROXY_HOST`, в production запрещён).

## База данных

| Команда | Что делает | Под какой ролью |
| --- | --- | --- |
| `pnpm db:roles` | создаёт/обновляет роли `modulyn_owner` и `modulyn_app` | суперпользователь (`DATABASE_ADMIN_URL`) |
| `pnpm db:migrate` | `prisma migrate deploy` | владелец схемы (`MIGRATION_DATABASE_URL`) |
| `pnpm db:setup` | roles + migrate | — |
| `pnpm db:seed` | синтетические nova, company-b, suspended-co; отказывается при `NODE_ENV=production` | владелец схемы |
| `pnpm db:drift` | сравнивает живую БД со `schema.prisma`; пустой diff — код 0 | владелец схемы |

API работает только под `modulyn_app`. Если `DATABASE_URL` указывает на суперпользователя, роль с BYPASSRLS или владельца таблиц, readiness и все операции с данными компаний отвечают 503, а в логе указывается причина. Prisma не отслеживает CHECK-ограничения, RLS-политики и GRANT: они в SQL миграций (`apps/api/prisma/migrations`). Новые миграции создаются командой `prisma migrate dev` в `apps/api`; RLS для новых таблиц с `tenant_id` дописывается в их SQL вручную по образцу `20261116130000_phase2_rls`.

## Проверки

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:integration
pnpm smoke
```

`pnpm check` выполняет typecheck, lint, unit-тесты и build без базы данных. `pnpm test:integration` требует запущенный PostgreSQL (`pnpm infra:up`): пересоздаёт отдельную базу `<POSTGRES_DB>_test`, создаёт роли, применяет миграции и seed, затем проверяет изоляцию компаний под ролью `modulyn_app` (чтение, изменение, удаление, IDOR, RLS без контекста, пул соединений, конкурентные запросы, менеджер в двух компаниях) и вход (пароль, переход в компанию, ротация и отзыв сессий, границы tenant/app/platform, CSRF, ограничение входа, Google через локальный поддельный OIDC-провайдер). Рабочая база не затрагивается. Smoke требует запущенный стек и `pnpm db:seed`.

- `/api/health` → 200, `{ "status": "ok", "service": "modulyn-api" }` на любом hostname.
- `/api/health/ready` → 200, `{ "status": "ready", "database": "up" }`; 503 при недоступной БД или небезопасной роли.
- `/api/tenant` → 200 с `slug` и `displayName` для активной компании; 404 одинакового вида для неизвестной, отключённой, зарезервированной (`www`, `api`, …), вложенной или чужой.

## Как читать код

1. `packages/config/tsconfig.base.json` — общие строгие правила TypeScript.
2. `packages/contracts/src/index.ts` — публичные типы ответов API, без моделей БД.
3. `apps/api/src/main.ts`, `bootstrap.ts` — проверка окружения, Nest, Helmet, определение компании до контроллеров.
4. `apps/api/prisma/schema.prisma` и `prisma/migrations` — модель данных Phase 2, CHECK, RLS, права.
5. `apps/api/scripts/db-roles.mjs` — роли БД; `scripts/seed.mjs` — синтетические данные.
6. `apps/api/src/tenancy/hostname.ts` — разбор Host в компанию; `tenancy.middleware.ts` — поиск компании и контекст запроса; `request-context.ts` — AsyncLocalStorage.
7. `apps/api/src/database/database.service.ts` — PrismaClient и проверка runtime-роли; `tenant-db.service.ts` — транзакция компании с `set_config('app.tenant_id', …, true)`; `tenant-directory.service.ts` — поиск активной компании.
8. `apps/api/test/integration/isolation.test.mjs` — доказательства изоляции.
9. Вход (Phase 3): `apps/api/src/auth/auth.guard.ts` — глобальная проверка каждого запроса; `sessions.service.ts` — выдача, проверка и ротация сессий; `auth.controller.ts` — маршруты входа и перехода в компанию; `origin.middleware.ts` — CSRF; `src/database/auth-store.service.ts` — единственный доступ к аккаунтам и сессиям; `apps/web/src/features/auth` — страницы входа, выбора компании и каркас CRM. Тесты: `apps/api/test/integration/auth.test.mjs`.
9. `docker-compose.yml` и `infra/proxy/default.conf` — сервисы, порядок запуска, маршрутизация.

## Ограничения

Это локальная основа, не готовый production SaaS. Нет приглашений сотрудников и сброса пароля по email (Phase 5), управления модулями (Phase 6), заявок (Phase 7–8). Вход через настоящий Google проверяется после создания OAuth-клиента (автотесты используют поддельного провайдера). Production TLS/DNS не настроены. Runtime-образ API содержит build dependencies и Prisma CLI (нужен сервису migrate).

## Работа AI-агентов

Начинать с `AGENTS.md` / `CLAUDE.md` и `SPEC.md`. После каждой итерации обновлять статус, выполненные проверки, оставшуюся работу и следующий шаг. Не переходить к следующей фазе без одобрения пользователя.
