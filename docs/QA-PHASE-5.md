# QA — Phase 5 React storefront source checkpoint

## Статус

Это исходная контрольная сборка frontend-подпроекта. Не является готовым production build.

## Локальные автоматические проверки

- Линтер: 75 JS-файлов, 0 замечаний.
- Полный Node test suite: 145 passed, 0 failed.
- JavaScript syntax check для Vite config, React app и SSR renderer пройден.

- Корневой backend сохраняет `dependencies: {}`.
- JS исходники React app проверяются `node --check` через проектный lint.
- Node tests проверяют React/Vite конфигурацию, local Spotlight implementation, отсутствие esm.sh import map, progressive fallback и выбор `public/react-app/index.html` только после сборки.
- Существующий API, auth, routing, import и CRM test suite запускается через `npm run check`.

## Не выполнено в изолированной среде

- `npm install` / `vite build`: попытка установки зависимостей завершилась timeout на обращении к npm Registry; production bundle не собран.
- Реальная OriginKit CLI установка: требует авторизации через браузер и доступа с компьютера разработчика.
- Браузерный screenshot/E2E: Chromium в этой изолированной среде блокирует localhost-навигацию (`ERR_BLOCKED_BY_ADMINISTRATOR`), поэтому desktop/mobile визуальную проверку здесь подтвердить нельзя.

## Smoke-проверки после локальной сборки

1. `npm run setup:storefront`
2. `npm start`
3. `GET /` должен отдавать новый React `index.html`.
4. `GET /react-app/assets/vapelab-storefront.js` и `.css` должны отвечать 200.
5. `/tabak`, `/product/<существующий-slug>`, `/news/<существующий-slug>` должны сохранить SSR/SEO метаданные.
6. `/crm`, `/api/health`, `/robots.txt`, `/sitemap.xml` должны остаться рабочими.
7. `GET /not-a-real-route` должен вернуть 404.
8. Проверить desktop 1440px, tablet 768px, mobile 390px и reduced motion.

## Проверено в отдельном smoke-процессе backend

- `/`, `/crm`, `/tabak`, `/stiki-terea-dlya-iqos-iluma`, `/parovye-kamni-dlya-kalyana`, `/robots.txt`, `/sitemap.xml`, `/reactbits/spotlight-fallback.js`, `/favicon.svg` — HTTP 200.
- Несуществующая страница и React bundle, который ещё не собран, — HTTP 404.
- До появления production build SSR-страницы не ссылаются на отсутствующие React CSS/JS-файлы.
- Публичный API в проверочной БД: 23 категории, 76 товаров, 6 новостей; sitemap: 101 URL.
- Локальные ресурсы `img`, `script`, `link` на главной, `/tabak` и вложенной категории доступны.
