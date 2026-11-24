# VAPELAB public storefront — React/Vite

Это отдельное React-приложение публичной витрины. Существующий Node.js backend, SQLite/PostgreSQL, API и CRM остаются в корне проекта и не требуют React-зависимостей.

## Требования

- Node.js 22.12 или новее для Vite 8.
- npm.
- Backend VAPELAB доступен на `http://127.0.0.1:3000` при dev-режиме.

## Локальная разработка

Терминал 1 — backend из корня проекта:

```cmd
npm start
```

Терминал 2 — React-витрина:

```cmd
cd storefront-react
npm install
npm run dev
```

Откройте `http://127.0.0.1:5173`. В dev-режиме Vite использует корневой base `/` и проксирует `/api`, CRM, все наблюдаемые маршруты категорий и брендовые файлы в Node backend. Для нестандартного backend URL задайте `VAPELAB_BACKEND_URL`.

## Production build

Из корня проекта:

```cmd
npm run setup:storefront
```

Команда устанавливает только frontend-зависимости в `storefront-react/node_modules` и собирает локальный bundle в `public/react-app/`. Корневой сервер автоматически начинает отдавать `public/react-app/index.html` на `/`, если build существует; до этого используется безопасный классический HTML fallback `public/storefront.html`.

После сборки перезапустите Node backend и проверьте `/`, категории и страницы товаров. Серверные category/product/news pages подключают тот же локальный React Bits bundle. `public/react-app/` — генерируемый каталог, его не редактируют вручную.

## Компоненты

- `src/components/SpotlightAdapter.js` — адаптер, который автоматически подхватывает официальный React Bits Spotlight Card после локальной установки в `src/components/visuals/`; до этого использует независимый fallback `VapelabGlowCard.js`.
- `src/components/OriginKitHeroAdapter.js` — ищет локально установленный Hero 58 export в `src/components/originkit/`; пока исходника нет, отображается particle-wave fallback.
- `scripts/install-reactbits.ps1` — временно переключает конфигурацию shadcn, устанавливает официальный `@react-bits/SpotlightCard-JS-CSS` из реестра React Bits и восстанавливает конфигурацию OriginKit.
- Официальный компонент React Bits не включён исходным кодом в этот ZIP: проект сохраняет ссылку и установщик, а исходник загружается непосредственно из реестра в рабочую копию владельца.
- `src/main.js` — React главной страницы, API-клиент, skeleton-состояния, адаптивная навигация и локальная инициализация Spotlight для SSR-карточек.
- `src/styles.css` — визуальная система VAPELAB.
- `public/hero-58-visual.js` пока остаётся локальной canvas-адаптацией. Для установки оригинального OriginKit Hero 58 см. `ORIGINKIT-HERO58.md` и `VISUAL-COMPONENTS-SETUP.md`.
- `jsconfig.json` содержит alias `@/*`, который использует shadcn при установке компонентов.

## Ограничения текущего этапа

- Реальный OriginKit Hero 58 ещё не скачан: требуется OAuth-вход в OriginKit CLI на компьютере владельца. Текущий Hero — явно обозначенная локальная адаптация. Запустите `scripts/install-originkit-hero58.ps1`, затем `npm run inspect:originkit`; после проверки точного экспортируемого компонента его нужно подключить вместо адаптации.
- Production Vite build требует `npm install` на машине с доступом к npm Registry. В текущей изолированной среде DNS `registry.npmjs.org` возвращает `EAI_AGAIN`, поэтому скомпилированные `public/react-app/*` намеренно не подменяются выдуманными файлами.
- Google Fonts пока подключаются из Google Fonts; при сетевой недоступности остаются системные fallback-шрифты.
- Изображения товаров не создаются автоматически и не заменяются случайными стоковыми фото.

## Windows quick start

Из корня проекта откройте два терминала. В первом:

```cmd
npm start
```

Во втором:

```cmd
cd storefront-react
npm install
npm run dev
```

Откройте `http://127.0.0.1:5173`. Для проверки production-пути выполните `npm run setup:storefront` из корня проекта и перезапустите Node backend. Команда не изменяет CRM API или схему базы.
