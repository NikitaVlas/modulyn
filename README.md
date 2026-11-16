# Modulyn

Модульная multi-tenant CRM. Текущий объём — Phase 1: технический каркас. Авторизация, tenant isolation и бизнес-модули ещё не реализованы. Источник плана, разрешений и статусов: [SPEC.md](SPEC.md).

## Требования

- Node.js 26.13.0 (версия закреплена в `.node-version`).
- pnpm 12.21.0 (поле `packageManager`). Если установлен другой pnpm, используйте `npx --yes pnpm@12.21.0` вместо `pnpm` во всех командах ниже.
- Docker Engine и Compose; Docker Desktop должен быть запущен на Windows.
- Свободные локальные порты: 8080 (Compose), 5433 (PostgreSQL), 3000 и 3001 (разработка без контейнеров приложений).

## Быстрый запуск в Docker

Из корня проекта:

```sh
pnpm install --frozen-lockfile
pnpm env:init
pnpm stack:up
pnpm smoke
```

`env:init` создаёт `.env` со случайным паролем PostgreSQL, не печатает его и не перезаписывает существующий файл. `.env` исключён из Git и Docker build context. `.env.example` описывает переменные; при ручном редактировании пароля используйте URL-safe значение либо правильно кодируйте его в DATABASE_URL. В Compose DATABASE_URL собирается из POSTGRES_*; оставляйте пароль в hex-формате, который создаёт скрипт.

Открыть:

- http://nova.localhost:8080 — стартовая страница.
- http://company-b.localhost:8080 — то же приложение; определения tenant пока нет.
- http://admin.localhost:8080 — та же стартовая страница, административная панель появится позже.
- http://nova.localhost:8080/api/health — liveness API.
- http://nova.localhost:8080/api/health/ready — readiness с реальным запросом к БД.

Если система не разрешает `*.localhost`, для общей проверки доступен http://localhost:8080. Для нужных поддоменов можно добавить в hosts `127.0.0.1 nova.localhost company-b.localhost admin.localhost`. Скрипт smoke передаёт hostname в HTTP-заголовке Host, подключаясь к 127.0.0.1; поэтому не зависит от разрешения *.localhost в Node.js. Переменная SMOKE_ORIGIN позволяет выбрать другой локальный HTTP-адрес и порт. DNS/hosts автоматически не меняются.

```sh
docker compose ps
docker compose logs --tail=100 api web proxy db
pnpm stack:down
```

`stack:down` сохраняет named volume PostgreSQL. Не используйте `docker compose down -v`, если данные нужно сохранить. Изменение POSTGRES_PASSWORD в `.env` не меняет пароль уже созданной БД; существующий volume нужно обслуживать отдельно, не удалять автоматически.

## Разработка с перезагрузкой

```sh
pnpm env:init
pnpm infra:up
pnpm dev
```

`pnpm dev` загружает `.env`, сначала собирает contracts и API, затем запускает TypeScript watch, перезапуск API и Next.js dev. Ctrl+C останавливает дочерние процессы. Открыть http://nova.localhost:3000; Next.js перенаправляет `/api/*` на локальный API :3001. Для полного Compose proxy используйте режим выше. API_PORT в этом режиме оставляйте 3001, либо согласованно меняйте rewrite в next.config.ts.

## Проверки

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
```

`pnpm typecheck` сначала собирает contracts, поэтому работает и на чистом workspace. `pnpm check` выполняет общую последовательность проверок; smoke требует запущенный стек. Unit-тесты не требуют PostgreSQL, реальное соединение проверяет smoke.

- `/api/health` → 200, `{ "status": "ok", "service": "modulyn-api" }`.
- `/api/health/ready` → 200, `{ "status": "ready", "database": "up" }` при доступной БД; иначе 503 с общей ошибкой.
- Неизвестный API-маршрут → 404.

Для проверки сбоя БД на локальных тестовых данных: `docker compose stop db`, запросить readiness (ожидается 503), затем `docker compose start db`, дождаться готовности и повторить smoke. Liveness при этом остаётся 200. Не выполнять этот сценарий на рабочем сервере.

## Как читать код

1. `packages/config/tsconfig.base.json` — общие строгие правила TypeScript.
2. `packages/contracts/src/index.ts` — публичные типы технических ответов, без моделей БД.
3. `apps/api/src/main.ts` — проверка окружения и запуск.
4. `apps/api/src/bootstrap.ts` — создание Nest, security headers, префикс `/api`, shutdown hooks.
5. `apps/api/src/app.module.ts` — регистрация controller и service.
6. `apps/api/src/health/health.controller.ts` — разделение liveness/readiness, безопасная ошибка 503.
7. `apps/api/src/database/database.service.ts` — небольшой pg pool и статический `SELECT 1`; бизнес-запросов нет. Prisma вводится в Phase 2 после согласования схемы.
8. `apps/web/src/app/layout.tsx` и `page.tsx` — серверный каркас страницы, metadata, язык и содержимое.
9. `docker-compose.yml` и `infra/proxy/default.conf` — сервисы, зависимости по healthcheck, маршрутизация и persistent volume.

## Ограничения Phase 1

Это локальная основа, не готовый production SaaS. Публичные health endpoints не содержат клиентских данных. Нет login, сессий, RBAC, tenant resolution/RLS, Prisma schema, миграций и lead/email-модулей. Поддомены пока не обеспечивают изоляцию. Production TLS/DNS не настроены. Runtime-образ для локального MVP сохраняет build dependencies; уменьшение образа и production hardening выполняются в отдельном согласованном объёме.

## Работа AI-агентов

Начинать с `AGENTS.md` / `CLAUDE.md` и `SPEC.md`. После каждой итерации обновлять статус, выполненные проверки, оставшуюся работу и следующий шаг. Не переходить в Phase 2 без одобрения пользователя.
