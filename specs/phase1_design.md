# Phase 1 — технический план

Источник требований, одобрений и статусов: [SPEC](../SPEC.md).

Frontend: минимальная серверная страница Next.js, общий layout, Tailwind, без форм, авторизации и фиктивных CRM-данных.

Backend: NestJS GET /api/health (жизнеспособность) и GET /api/health/ready (SELECT 1, 503 при недоступной БД). pg используется только для проверки подключения; Prisma и бизнес-модель реализуются в Phase 2 после согласования schema.

Безопасность: публичные технические endpoints не возвращают credentials или подробности ошибки. Конфигурация проверяется при запуске, SQL статический, Helmet, proxy заменяет forwarded headers. Порты Compose доступны только через loopback. Auth/RBAC и tenant resolution не реализуются в Phase 1. Данные клиентов не подключаются.

Проверки: конфигурация (включая ошибки без секретов), readiness success/failure, typecheck/lint/build, HTTP smoke через proxy, остановка БД → 503 → восстановление.
