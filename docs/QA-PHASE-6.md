# QA report — Phase 6 visual integration preparation

Дата: 23.11.2026

## Автоматические проверки

Команда: `npm run check`

- Линтер: 77 JS-файлов, замечаний нет.
- Node test suite: 146 passed, 0 failed.
- Новые тесты проверяют React Bits adapter/registry configuration, независимый fallback, отсутствие upstream-source в ZIP, Hero 58 adapter/fallback и авторизованные install scripts.

## HTTP smoke и crawl

Запущен отдельный Node backend с временной SQLite-базой `DATA_DIR=/mnt/data/vapelab_phase6_crawl_data`; пользовательская база и production `.env` не использовались.

- `/`, `/crm`, `/tabak`, `/robots.txt`, `/sitemap.xml`, `/favicon.svg` — HTTP 200.
- Несуществующая HTML-страница и отсутствующий статический файл — HTTP 404.
- Sitemap: 101 URL; проверено 101/101 HTTP 200, 0 ошибок.
- API: 23 категории, 76 товаров, 6 новостей.
- Товарная страница `atom-good-5000-hard` открывается с HTTP 200.

## Не выполнено в среде

- Production Vite build не запускался до конца из-за недоступности npm Registry (DNS resolution / timeout).
- OriginKit CLI не может быть авторизован от имени владельца. Оригинальный Hero 58 не скачан.
- React Bits upstream source не включён в ZIP по условиям лицензии; installer обеспечивает прямую загрузку владельцем из официального registry.
- Визуальный браузерный E2E ранее блокировался средой (`ERR_BLOCKED_BY_ADMINISTRATOR`).

Результаты автоматических тестов не заменяют production build и визуальное тестирование в браузере. Этап остаётся открытым до установки компонентов, успешной Vite-сборки и просмотра desktop/mobile.
