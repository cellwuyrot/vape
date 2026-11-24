# Phase 6 — локальная установка официальных визуальных компонентов

## Что подготовлено в проекте

- React-витрина изолирована в `storefront-react/`; Node backend и CRM остаются отдельными.
- `SpotlightAdapter.js` обнаруживает официальный React Bits Spotlight Card в `src/components/visuals/` после локальной установки.
- До установки используется независимый fallback `VapelabGlowCard`, без CDN и без upstream-кода React Bits.
- Подготовлен PowerShell-установщик React Bits через официальный shadcn registry. Он временно меняет конфигурацию и возвращает исходный `components.json` в `finally`.
- Добавлен `jsconfig.json` с alias `@/*`, используемым shadcn.
- `OriginKitHeroAdapter.js` обнаруживает локальный Hero 58 в `src/components/originkit/` и рендерит найденный React export; до получения исходников остаётся particle-wave fallback.
- Подготовлены PowerShell-установщик OriginKit Hero 58 и скрипт анализа скачанных файлов и экспортов.
- Устранён некорректный обработчик focus, который передавал focus event в функцию pointer coordinates.
- В документации исправлены прежние утверждения о включённом в ZIP исходнике React Bits.

## Проверенные официальные процедуры

OriginKit Hero 58: https://www.originkit.dev/sections/hero-58 — страница указывает Gauze Blaze и CLI `npx originkit@latest add hero-58`.

React Bits Spotlight Card: https://reactbits.dev/components/spotlight-card. Документация установки: https://reactbits.dev/get-started/installation. Upstream source не распространяется в текущем ZIP; владелец скачивает его напрямую из официального registry.

## Проверки текущего checkpoint

- `npm run check`: линтер 77 JS-файлов, замечаний нет; 146 тестов пройдены, 0 провалов.
- Чистый временный runtime: `/`, `/crm`, `/tabak`, `/robots.txt`, `/sitemap.xml`, `/favicon.svg` вернули 200.
- Реальный crawl всех 101 URL sitemap: 101 ответ HTTP 200, 0 ошибок.
- Несуществующая HTML-страница и отсутствующий статический файл возвращают 404.
- Публичный API вернул 23 категории, 76 товаров и 6 новостей.
- Исходник проверен Node syntax/lint; Vite compile ещё не подтверждён.

## Не завершено / внешние блокеры

- Vite production bundle в этой среде не собран: npm Registry не резолвится по DNS, вызов npm install/ping завершается сетевым тайм-аутом. Не создавались поддельные bundle-файлы.
- Оригинальный OriginKit Hero 58 ещё не скачан: требуется интерактивный вход владельца в OriginKit CLI. API компонента и его обязательные props нельзя предполагать заранее.
- Официальный React Bits Spotlight Card ещё не загружен в эту копию; подготовлены registry config, installer и adapter.
- Визуальный Playwright/Chromium E2E ранее блокировался политикой среды (`ERR_BLOCKED_BY_ADMINISTRATOR`); нужен запуск после локального build на ПК владельца.
- Локальные Unbounded/Inter ещё не включены как шрифтовые файлы: Google Fonts используются с системными fallback.

## Действия владельца на Windows

Из каталога проекта открыть PowerShell и выполнить:

```powershell
cd .\storefront-react
powershell -ExecutionPolicy Bypass -File .\scripts\install-originkit-hero58.ps1
npm run inspect:originkit
powershell -ExecutionPolicy Bypass -File .\scripts\install-reactbits.ps1
npm install
npm run build
```

Затем вернуться в корень и запустить Node backend (`npm start`). Не передавать OAuth/CLI credentials или секреты. Для проверки нужно передать только публичные исходники каталогов `storefront-react/src/components/originkit/` и `storefront-react/src/components/visuals/`, если потребуется ручная адаптация экспорта.

## Отложенные требования

Блюр изображений, маркировка 18+, возрастная проверка и ограничение доступа пока намеренно не реализованы.
