## Уточнение статуса в Phase 6

Указание выше о включённом исходнике SpotlightCard отражает состояние промежуточной рабочей копии Phase 5 и больше не является описанием текущего ZIP. В текущем распространяемом архиве upstream-код SpotlightCard удалён; он устанавливается владельцем напрямую из официального registry. Витрина использует независимый fallback до получения исходника. См. `docs/PHASE-6-VISUAL-COMPONENT-INSTALL.md`.

# VAPELAB Phase 5 — изолированная React-витрина

Дата: 23.11.2026

## Реализовано в исходниках

- Добавлено отдельное приложение React 19 + Vite 8 в `storefront-react/`; корневые зависимости backend остаются пустыми.
- Dev-сервер Vite проксирует публичный API, CRM и маршруты каталога на Node backend.
- Production output настроен в `public/react-app/`. Node route `/` выбирает React `index.html` только после реальной сборки; без сборки используется текущий HTML fallback.
- Server-rendered страницы категорий и товаров подключают локальный React bundle только когда оба файла сборки реально существуют; до этого не отправляются ошибочные запросы к несуществующим CSS/JS.
- Удалена загрузка React/React DOM с `esm.sh` через import map. Старый неиспользуемый ESM-модуль `public/reactbits/spotlight-card.js` удалён.
- Для SSR карточек добавлен локальный progressive-enhancement fallback `public/reactbits/spotlight-fallback.js`, который учитывает coarse pointer и reduced motion.
- Добавлен настоящий React-компонент SpotlightCard по публичному исходнику React Bits: `useRef`, `onMouseMove`, CSS custom properties. В prod он попадёт в локальный Vite bundle.
- Главная переведена на React: API fetch с AbortController и timeout, loading skeletons, компактные категории, раскрываемая таксономия, информация о компании, направления, публикации и контакты.
- Сохранена чёрно-белая палитра с умеренными синими/голубыми акцентами, логотип в круглой белой области и увеличенная типографика.
- Добавлены проверки исходников React/Vite, удаления внешнего React CDN и маршрута выбора production index. Dev proxy синхронизирован со всеми текущими вложенными slug и favicon. Base path различается: `/` для dev и `/react-app/` для production.
- Удалены декоративные цифровые индексы из карточек категорий и направлений.
- В `components.json` подготовлена интеграция OriginKit для Vite + CSS + JS.

## Не завершено

- Production React bundle не скомпилирован в текущей среде: DNS к npm Registry недоступен. Выпуск архива содержит исходники сборки и рабочий fallback, но не содержит фальшивых/ручных замен `react`, `react-dom` и Vite bundle.
- Официальный OriginKit Hero 58 ещё не получен. OriginKit CLI требует browser login на машине разработчика; текущий `public/hero-58-visual.js` остаётся самостоятельной canvas-адаптацией, не исходником Hero 58.
- После получения дерева `hero-58` нужно осмотреть экспорт и зависимости, подключить component в `Hero` и собрать production bundle.
- Визуальный браузерный E2E для dev/build не проведён: установленный Chromium заблокировал локальную навигацию политикой среды (`ERR_BLOCKED_BY_ADMINISTRATOR`). Требуется проверить desktop/mobile на ПК пользователя после `npm install`.
- Локальные файлы Unbounded/Inter пока не упакованы, Google Fonts загружаются из сети с system fallback.

## Отложено по решению владельца

Blur изображений, маркировка контента 18+ и возрастная проверка по-прежнему не реализованы.

## Дополнительные проверки Phase 5

- Линтер: 75 JavaScript-файлов, замечаний нет.
- Node test suite: 145 passed, 0 failed.
- HTTP smoke test отдельного backend процесса: `/`, `/crm`, `/tabak`, все проверенные вложенные категории, `robots.txt`, `sitemap.xml`, favicon и Spotlight fallback — 200; несуществующая страница и отсутствующий React bundle до сборки — 404.
- Sitemap: 101 URL; публичный API: 23 категории, 76 товаров, 6 новостей.
- Проверены локальные `img`, `script`, `link` ресурсы на главной, категории и вложенной категории: все проверенные ресурсы доступны.
- `npm install` в контейнере не завершился из-за сетевого timeout при обращении к npm Registry, поэтому Vite production build не подтверждён.
