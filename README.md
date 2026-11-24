# VAPELAB — витрина и CRM

Единая система VAPELAB: публичная информационная витрина, каталог и CRM с управлением товарами,
категориями, публикациями, сотрудниками, SEO-полями, импортом XLSX/CSV, задачами и клиентами.
Публичная витрина не оформляет дистанционные покупки. Вход посетителей и сотрудников — по одноразовому
коду e-mail; роль посетителя не получает доступ к CRM.

Визуальная система: графитовый чёрный, белый, синий и голубой акценты. Заголовки — Unbounded
и Inter загружаются через Google Fonts; при недоступности сети используются системные sans-serif fallback.

---

## Запуск

```bash
npm install
npm run seed     # демо-данные, по желанию
npm start        # http://localhost:3000
```

Первичный главный администратор создаётся автоматически: `andycoulbot@gmail.com`. Пароля нет: запросите одноразовый код на e-mail. При локальном запуске без SMTP код пишется в консоль сервера как `notify.dev`; в рабочем окружении задайте SMTP-провайдер.

**Серверная часть в корне проекта не имеет внешних npm-зависимостей.** Она работает на встроенных модулях Node.js 22 (`node:sqlite`, `node:http`). Публичная React-витрина вынесена отдельно в `storefront-react/` и использует React, React DOM, Vite и `@vitejs/plugin-react`; для её сборки нужен Node.js 22.12+ и доступ к npm Registry. Для шрифтов интерфейс обращается к Google Fonts; при недоступности сети используются системные fallback-шрифты.
Драйвер PostgreSQL и подпись S3 тоже написаны на стандартной библиотеке — обещание
установки без обращения к реестру сохраняется и для боевого контура.

### Импорт каталога VAPELAB и подготовка через Qwen

Для сбора открытых фактов из каталога, подготовки папок изображений и точечной обработки карточек Qwen см. `docs/PRODUCT-IMPORT-QWEN-WORKFLOW.md` и `docs/VAPELAB-SOURCE-CATALOG-REVIEW.md`. Парсер: `tools/vapelab_catalog_parser.py`; Python-зависимости — `tools/requirements-vapelab-parser.txt`. Импортёр принимает XLSX/CSV и позволяет вручную назначить каждой колонке целевое CRM-поле, включая вариант «не импортировать».

Офлайн-тесты парсера запускаются отдельно: `py -m unittest discover -s tools -p "test_*.py"`. Скрипт не публикует товары: все строки CSV принудительно получают draft/noindex/без бронирования; Qwen может готовить только нейтральное описание и SEO-поля, не цены и не SKU.

### Импорт каталога VAPELAB и подготовка через Qwen

Для сбора открытых фактов из каталога, подготовки папок изображений и точечной обработки карточек Qwen см. `docs/PRODUCT-IMPORT-QWEN-WORKFLOW.md` и `docs/VAPELAB-SOURCE-CATALOG-REVIEW.md`. Парсер: `tools/vapelab_catalog_parser.py`; Python-зависимости — `tools/requirements-vapelab-parser.txt`. Импортёр принимает XLSX/CSV и позволяет вручную назначить каждой колонке целевое CRM-поле, включая вариант «не импортировать».

Офлайн-тесты парсера запускаются отдельно: `py -m unittest discover -s tools -p "test_*.py"`. Скрипт не публикует товары: все строки CSV принудительно получают draft/noindex/без бронирования; Qwen может готовить только нейтральное описание и SEO-поля, не цены и не SKU.

Другие команды:

| Команда | Что делает |
|---|---|
| `npm run dev` | запуск с автоперезагрузкой при правках |
| `npm test` | полный набор тестов: API, миграции, диалект SQL, протокол PostgreSQL, хранилище, бэкапы, наблюдаемость |
| `npm run lint` | собственный линтер: забытый `await`, `console.log`, подстановки в SQL, внешние зависимости |
| `npm run check` | линтер и тесты одной командой — то же, что гоняет CI |
| `npm run migrate` | накатить миграции схемы отдельно от старта приложения |
| `npm run backup` | снять копию, проверить восстановление, ротировать, выгрузить в S3 |
| `npm run restore-check` | развернуть последнюю копию во временный каталог и сверить с манифестом |
| `npm run seed` | демо-данные: клиенты, сделки, заказ, три диалога |
| `npm run reset` | очистить базу |

### Хранилище: SQLite или PostgreSQL

По умолчанию — SQLite в `DATA_DIR`. Для боевой нагрузки (больше 30–50 одновременных
пользователей) достаточно одной переменной, прикладной код не меняется:

```bash
DATABASE_URL=postgres://rucrm:пароль@localhost:5432/rucrm?sslmode=require
npm run migrate && npm start
```

Схема создаётся версионными миграциями из каталога `migrations/`, применённые версии
хранятся в таблице `schema_migrations`. Подробности — `docs/OPERATIONS.md`.

---

## Публикация в интернете

Приложение слушает `PORT` и отдаёт сайт и API с одного порта — подходит любому хостингу.

**Docker (свой сервер, VPS в РФ)**
```bash
cp .env.example .env    # заполните SECRET_KEY, SMTP_URL и MAIL_FROM
docker compose up -d --build
```

**Render, Railway, Fly и подобные**: репозиторий содержит `render.yaml` — платформа подхватит
`npm install` и `npm start` сама. Обязательно смонтируйте постоянный диск в `DATA_DIR`,
иначе база будет теряться при каждом деплое.

**Российские площадки**: Timeweb Cloud Apps, VK Cloud, Yandex Serverless Containers, Selectel.
Для соблюдения 152-ФЗ выбирайте именно их: персональные данные граждан РФ должны
храниться на серверах в России.

**Публичные маршруты и индексация.** `/` — витрина, `/crm` — отдельная оболочка CRM
(закрыта от индексации), `/robots.txt` и `/sitemap.xml` — служебные SEO-файлы.
Неизвестные HTML-адреса возвращают настоящий HTTP 404, статические HTML-файлы нельзя
открыть в обход явных маршрутов. Для категорий реализованы короткие URL (`/tabak`, `/stiki`,
`/pod-sistemy` и другие), для товаров — `/product/:slug`, для новостей — `/news/:slug`.
Sitemap собирает только опубликованные индексируемые страницы; пустые категории и внешние
canonical URL в него не включаются. В production задайте `PUBLIC_URL=https://ваш-домен`.

**Классический сервер**: в каталоге `deploy/` лежат `rucrm.service` для systemd, `nginx.conf`
с HTTPS и увеличенным таймаутом под long-poll инбокса, а также таймер резервного копирования.

```bash
sudo cp deploy/rucrm.service /etc/systemd/system/ && sudo systemctl enable --now rucrm
sudo cp deploy/nginx.conf /etc/nginx/sites-enabled/rucrm && sudo nginx -s reload
sudo cp deploy/rucrm-backup.* /etc/systemd/system/ && sudo systemctl enable --now rucrm-backup.timer
```

Балансировщик и оркестратор опрашивают `/api/ready` — процесс сообщает готовность только
после наката миграций и проверки хранилища, а при остановке сразу отвечает `503`.
`/api/health` — простая проверка живости, `/api/metrics` — метрики в формате Prometheus.

---

## Витрина: бронирования, SEO и аналитика

Руководство по каталогу с серверной пагинацией, умному поиску товаров, бронированиям без онлайн-оплаты, редактору новостей, Google Search-grounded черновикам, SEO-оценке, cookie-согласию, анонимной аналитике и Telegram webhook: [docs/VAPELAB-STORE-OPERATIONS.md](docs/VAPELAB-STORE-OPERATIONS.md).

## Переписка в мессенджерах

Ключевой сценарий: клиент пишет боту в мессенджер → сообщение попадает в общий инбокс CRM,
контакт и диалог создаются автоматически → сотрудник отвечает прямо из CRM → ответ приходит
клиенту в тот же мессенджер. История видна в карточке клиента.

| Канал | Как подключить |
|---|---|
| Telegram | Токен бота от @BotFather в `TELEGRAM_BOT_TOKEN`, username без `@` в `TELEGRAM_BOT_USERNAME`. Вебхук ставится автоматически, если задан `PUBLIC_URL`, либо вручную: `https://<домен>/api/webhooks/telegram/<TELEGRAM_WEBHOOK_SECRET>` |
| WhatsApp, MAX, Avito | Через агрегатор Wazzup24 (серверы в РФ): ключ в `WAZZUP_API_KEY`, вебхук `https://<домен>/api/webhooks/wazzup/<WAZZUP_WEBHOOK_SECRET>` |
| Форма на сайте | `POST https://<домен>/api/webhooks/webform` с полями `name`, `phone`, `email`, `text` |

Адреса вебхуков продублированы в интерфейсе, на странице «Настройки» — их можно скопировать в один клик.

Без подключённых провайдеров всё работает в демо-режиме: исходящие сообщения печатаются
в лог сервера, а кнопка «Демо-обращение» в инбоксе создаёт входящее сообщение.
Новый канал добавляется одним объектом в `server/channels.js`.

---

## Рутина менеджера

То, без чего менеджеры возвращаются в блокнот и Excel.

**Задачи и календарь.** Задача ставится из карточки клиента, сделки или диалога: тип
(звонок, встреча, письмо, сообщение), срок, напоминание. Отдельный раздел отвечает на три
вопроса: что просрочено, что сегодня, что на неделе. Календарь недели — семь колонок,
просроченное выделено. Напоминания рассылает планировщик внутри процесса, повтор
исключён флагом в базе, так что перезапуск сервиса не приводит к второму письму.

**Несколько воронок.** Продажи, повторные продажи, сервис — у каждой свой набор стадий,
переключатель над доской. Стадия может требовать заполненных полей: сумму, клиента,
следующий шаг. Проверка живёт на сервере, а не в форме, обойти её из API нельзя.

**Обязательная причина отказа.** Стадия отказа не закрывается без причины из справочника —
иначе отчёт по потерям превращается в графу «прочее». Справочник правится в настройках,
скрытая причина остаётся в базе: на неё ссылаются уже закрытые сделки.

**Дубли и склейка.** Совпадение ищется по нормализованному телефону, почте и ИНН:
`+7 (916) 555-33-11` и `89165553311` — один и тот же номер. Подсказка появляется прямо
при вводе, пакетная проверка базы — на отдельном экране. Склейка переносит сделки, заказы,
диалоги, задачи и ленту в основную карточку; донор не удаляется, а помечается
присоединённым — карточку с персональными данными нужно уметь показать по запросу субъекта.

**Импорт из Excel и CSV.** Выгрузки amoCRM и Битрикс24 распознаются по заголовкам, колонки
раскладываются автоматически, дальше — предпросмотр, правка сопоставления и пробный прогон
без записи. Повторный импорт того же файла не плодит дубли: совпадение по телефону, почте
и ИНН дополняет карточку. Формат xlsx разбирается своим кодом на `node:zlib` — зависимостей
по-прежнему ноль.

**Шаблоны быстрых ответов.** В инбоксе вызываются клавишей `/` или `Ctrl + Пробел`,
у каждого шаблона своё сокращение. Считается, сколько раз шаблон применили — видно,
что действительно работает. Рядом — загрузка вложений прямо из формы ответа.

**Печатные формы.** Коммерческое предложение, счёт, договор и акт: подстановка реквизитов,
позиции с НДС и сумма прописью по правилам русского языка. Бланк — обычный HTML с полями
вида `{{company.name}}`, правится в настройках без программиста. Документ открывается
в новой вкладке, дальше — «Печать → Сохранить в PDF». Свои реквизиты задаются
переменными `ORG_*`.

**Лента активности.** В карточке клиента — один поток: сделки, смены стадий, задачи,
звонки, заметки, заказы, документы и переписка из всех каналов, отсортированные по времени.

---

## Что внутри

**Клиенты и продажи** — контакты и компании с ИНН, КПП, ОГРН и идентификатором оператора ЭДО;
несколько воронок со своими стадиями и обязательными полями; задачи с напоминаниями и календарём;
поиск и склейка дублей; импорт из Excel, CSV, amoCRM и Битрикс24; печатные формы;
заказы с позициями, ставками НДС и полями под 1С, ЭДО и фискальный чек; товары;
сквозной поиск по всем сущностям (⌘K).

**Инбокс** — диалоги из всех каналов, лента переписки с группировкой по дням, ответ по ⌘+Enter,
шаблоны быстрых ответов по «/», вложения, задача из диалога, доставка новых сообщений
через long-poll, счётчик непрочитанных.

**Доступ** — единый вход посетителей и сотрудников по одноразовому коду e-mail (хеш кода,
срок 15 минут, лимит попыток); согласие на обработку ПДн при создании visitor-профиля;
подписанные сессионные токены; роли superadmin, admin, manager, agent, viewer и visitor.
Посетитель изолирован от CRM API; менеджеров приглашает администратор; журнал аудита сохраняется.

**Эксплуатация** — версионные миграции схемы, два драйвера базы за одним интерфейсом,
вложения в S3-совместимом хранилище с локальным диском как запасным вариантом,
резервные копии по расписанию с обязательной проверкой восстановления,
структурированные логи, метрики Prometheus и раздельные проверки живости и готовности.

```
migrations/     версионные миграции схемы (NNN_имя.sql)
server/
  config.js     переменные окружения (.env читается без зависимостей) и их проверка
  db.js         выбор драйвера, асинхронный мини-ORM, измерение времени запросов
  dialect.js    транслятор SQL: один запрос — две СУБД
  drivers/      sqlite.js, postgres.js, pg-protocol.js (свой клиент протокола 3.0)
  migrate.js    раннер миграций с контрольными суммами и транзакциями
  storage.js    вложения: S3-совместимое хранилище и локальный диск
  sigv4.js      подпись запросов к S3 на node:crypto
  backup.js     копии, проверка восстановления, ротация, выгрузка
  tar.js        минимальный tar для архивов копий
  scheduler.js  расписание фоновых задач внутри процесса
  logger.js     структурированные логи с идентификатором запроса
  metrics.js    счётчики и гистограммы в формате Prometheus
  auth.js       токены, e-mail-коды подтверждения, аудит
  smtp.js       SMTP STARTTLS / SMTPS и защита от отправки пароля без TLS
  pipelines.js  воронки, стадии, обязательные поля и причина отказа
  tasks.js      задачи, выборки «сегодня» и «просрочено», напоминания
  activity.js   лента активности: события и переписка одним потоком
  dedupe.js     нормализация телефонов и ИНН, поиск и склейка дублей
  importer.js   разбор xlsx и csv, профили amoCRM и Битрикс24, запись
  documents.js  печатные формы, мини-шаблонизатор, сумма прописью
  http.js       микро-роутер, разбор тела, ограничитель частоты
  channels.js   адаптеры Telegram, Wazzup24, формы сайта
  inbox.js      приём входящих и отправка ответов
  routes/       auth, users, store, crm, tasks, pipelines, inbox, quick-replies, import, documents, webhooks, files
scripts/        migrate, backup, restore-check
tools/lint.js   линтер проекта без внешних пакетов
public/
  index.html    оболочка
  app.css       тёмная графитовая тема с синими/голубыми акцентами
  fonts.css     типографические токены Inter / Unbounded
  js/core.js    DOM-хелперы, клиент API, форматирование
  js/app.js     маршрутизация, боковая панель, командная строка ⌘K
  js/views/     обзор, инбокс, задачи, клиенты, сделки, заказы, импорт, печать, настройки, вход
docs/           эксплуатация, комплаенс 152-ФЗ, дорожная карта, превью интерфейса
deploy/         systemd, таймер бэкапов и nginx
```

---

## Перед боевым запуском

1. Смените `SECRET_KEY`, настройте `SMTP_URL` и `MAIL_FROM=info@vaplab.ru`, поставьте `NODE_ENV=production`. Главный профиль `andycoulbot@gmail.com` создаётся автоматически и входит только по e-mail-коду; пароля администратора нет.
2. Разверните приложение и диск с базой в дата-центре на территории РФ, получите
   от провайдера письменное подтверждение местонахождения серверов.
3. Включите HTTPS и резервное копирование: `BACKUP_ENABLED=true` либо systemd-таймер.
   Хранилище копий — тоже в РФ. Проверка восстановления включена по умолчанию,
   не выключайте её: копия, которую ни разу не разворачивали, копией не является.
4. Подайте уведомление в Роскомнадзор, опубликуйте политику обработки ПДн, заключите
   договоры поручения с каждым обработчиком: агрегатором мессенджеров, почтовым провайдером, хостингом.
5. Проведите отдельную юридическую проверку текстов и процессов по чек-листу `docs/COMPLIANCE-152FZ.md`. Этот документ не является подтверждением соответствия и не заменяет проверку владельца и юриста.

Эксплуатация в бою — `docs/OPERATIONS.md`: миграции, переезд на PostgreSQL, вложения,
резервные копии, логи и метрики.

Следующая фаза — `docs/PHASE-2-AUTOMATION.md`: движок правил «событие — условие — действие»,
журнал срабатываний и тестовый прогон, распределение обращений, SLA, рабочее расписание
с часовыми поясами клиента, сценарный бот квалификации.

Подробности по развитию — `docs/ROADMAP.md`: 1С, Диадок и СБИС, онлайн-кассы по 54-ФЗ,
банковские выписки, телефония, маркировка «Честный знак».

---

## VAPELAB storefront extension

This RuCRM archive now includes a VAPELAB public catalog at `/` and the existing CRM at `/crm`. The CRM has a new «Витрина» workspace for categories, products, news, content pages and logo/favicon settings. See `docs/VAPELAB-IMPLEMENTATION.md` and `docs/vapelab-research/REPORT.md` for the implementation scope, observed-only inventory, source URLs, migration model and unresolved items.

## VAPELAB storefront — промежуточный этап 2.1

Состояние витрины и ограничения текущей итерации описаны в `docs/VAPELAB-STAGE-2-1.md`. Это рабочий этап для локального просмотра, не финальная версия для публикации.


## Вход и роли VAPELAB

- `andycoulbot@gmail.com` — главный администратор, создаётся при запуске.
- `admin` — администратор, `manager` — менеджер, `agent` — сотрудник, `viewer` — наблюдатель.
- `visitor` — посетитель с отдельным профилем; CRM API закрыто для этой роли.
- Новые посетители создают профиль по e-mail и согласию на обработку персональных данных.
- Менеджеров создаёт администратор в разделе «Команда». Приглашение приходит на рабочую почту.
- Для продакшена обязательно настройте SMTP URL, `MAIL_FROM=info@vaplab.ru` и длинный `SECRET_KEY`. Поддерживаются `smtp://user:pass@host:587` с STARTTLS, `smtps://user:pass@host:465` с TLS и HTTP webhook, принимающий JSON `from/to/subject/text`.

## Импорт каталога и изображения

В CRM → Витрина → Товары → «Импорт XLSX / CSV» можно загрузить таблицу, сопоставить колонки,
сделать пробный прогон и затем импортировать товары. Новые позиции по умолчанию получают статус
«Черновик». Поддерживаются поля категории, подкатегории, SKU, исходной цены/наличия, SEO и URL фото.

Автоматический поиск изображений подключается через Yandex Search API. Нужен каталог Yandex Cloud,
сервисный аккаунт с ролью `search-api.webSearch.user` и API-ключ с областью `yc.search-api.execute`.
Заполните `YANDEX_SEARCH_API_KEY` и `YANDEX_SEARCH_FOLDER_ID` в `.env` ([официальная инструкция](https://aistudio.yandex.ru/ru/docs/search-api/operations/search-images)).
Результаты отображаются для ручного выбора; найденная фотография не публикуется автоматически.
Проверьте соответствие модели и право использования изображения перед публикацией.

## Отложенные требования

Блюр изображений, маркировка материалов 18+ и возрастная проверка отмечены как следующий этап. В этой
версии они намеренно не реализованы.

## VAPELAB Stage 4 — visual checkpoint 3

The public storefront home page is now a compact company introduction with key category links, a collapsible full taxonomy, latest news and contacts. Category/product/news pages remain server-rendered and independently addressable. The public catalogue uses a black-and-white visual system with restrained blue/cyan accents and larger product cards.

The React/Vite storefront source is isolated in `storefront-react/`. Install and build it with `npm run setup:storefront`; the output is written to `public/react-app/` and the Node server serves that built index on `/`. The backend itself still has no external npm dependencies. See `storefront-react/README.md` and `docs/PHASE-5-REACT-STOREFRONT.md` for dev and build instructions.

React Bits SpotlightCard is prepared for installation from the official React Bits registry into the owner's working copy. The distributable ZIP does not contain upstream component source; `SpotlightAdapter.js` discovers it after installation and uses an independently authored VAPELAB fallback until then. No runtime import map or `esm.sh` dependency remains. See `docs/licenses/REACT-BITS-NOTICE.md`.

`public/hero-58-visual.js` remains a local particle-wave adaptation inspired by OriginKit Hero 58. It is not the official downloaded section; use `storefront-react/ORIGINKIT-HERO58.md` to authorize the CLI and add the exact Hero 58 source in the Vite subproject.

See `docs/PHASE-3-VISUAL.md` and `docs/QA-PHASE-3.log` for scope, verification and remaining constraints.

## VAPELAB: первичный главный администратор

По умолчанию `ADMIN_EMAIL=andycoulbot@gmail.com`. При существующей установке проверьте эту переменную непосредственно в `.env`: файл `.env.example` не перезаписывает уже существующий `.env`. Главный администратор входит только по одноразовому коду на e-mail; общего пароля/секретного обхода нет. До рабочего использования настройте SMTP и убедитесь, что адрес принадлежит владельцу проекта.

Шаблон импорта товарного каталога: `templates/VAPELAB-products-template.xlsx` (листы «Товары» и «Инструкция»).


## Phase 5 — React storefront source

The public home is now authored as a separate React application under `storefront-react/`. To develop it, run the Node backend with `npm start`, then run `npm install && npm run dev` from `storefront-react/`. To generate the local production bundle, run `npm run setup:storefront` from the project root.

The current archive contains React/Vite source, not prebuilt vendor files. The build could not be executed in the isolated environment because DNS access to the npm registry was unavailable. The built index is preferred only when `public/react-app/index.html` exists; otherwise the classic storefront HTML fallback remains available.


## VAPELAB Phase 5 — React storefront source

Исходник публичной витрины перенесён в отдельный React/Vite проект `storefront-react/`. Backend и CRM остаются в корне и не получают зависимостей React. Для локальной сборки выполните из корня `npm run setup:storefront`, затем `npm start`. Без production build сервер сохраняет старую безопасную HTML-витрину, не подключая отсутствующие bundle-файлы.

Для dev-режима запустите backend в первом терминале (`npm start`), во втором — `cd storefront-react`, `npm install`, `npm run dev`, затем откройте `http://127.0.0.1:5173`. Если backend работает на другом адресе, задайте `VAPELAB_BACKEND_URL`.

React Bits SpotlightCard устанавливается в локальную рабочую копию владельца через официальный shadcn registry с помощью `storefront-react/scripts/install-reactbits.ps1`. `SpotlightAdapter.js` автоматически подхватывает установленный компонент; до установки используется независимый fallback VAPELAB. Официальный исходник не включён в передаваемый ZIP. Текущая canvas particle-wave анимация — визуальная адаптация, не официальный OriginKit Hero 58. Для получения оригинального Hero 58 нужно авторизовать OriginKit CLI на машине разработчика; инструкция находится в `storefront-react/VISUAL-COMPONENTS-SETUP.md`.

Ограничения этого промежуточного пакета: npm Registry в изолированной среде недоступен, поэтому production Vite bundle не собран; browser E2E запуск заблокирован политикой среды (`ERR_BLOCKED_BY_ADMINISTRATOR`). Blur и возрастные механизмы 18+ по-прежнему отложены.


## Phase 6 — correction to third-party component distribution

В текущей контрольной сборке upstream-файлы React Bits не распространяются внутри ZIP. Официальный компонент Spotlight Card получает владелец напрямую из React Bits registry через `storefront-react/scripts/install-reactbits.ps1`; до этого React-витрина использует независимый компонент `VapelabGlowCard`. Оригинальный OriginKit Hero 58 также ещё не включён: его скачивание требует входа владельца через CLI. Официальные компоненты можно считать интегрированными только после установки, осмотра реальных файлов и подтверждённой Vite-сборки. См. `docs/PHASE-6-VISUAL-COMPONENT-INSTALL.md`.


## Phase 6 — установка официальных визуальных компонентов

Текущая копия содержит `OriginKitHeroAdapter.js` и `SpotlightAdapter.js`. Пока оригинальный Hero 58/React Bits не скачан, используются независимые VAPELAB fallback-компоненты. Официальные исходники устанавливаются владельцем из соответствующих реестров по инструкциям в `storefront-react/VISUAL-COMPONENTS-SETUP.md`. Для OriginKit CLI требуется интерактивная авторизация в браузере.

Для получения OriginKit Hero 58 и React Bits на Windows из `storefront-react/` выполните PowerShell-скрипты `scripts/install-originkit-hero58.ps1` и `scripts/install-reactbits.ps1`, затем `npm install` и `npm run build`. После успешной сборки запустите backend из корня (`npm start`). В текущей изолированной среде npm Registry недоступен по DNS, поэтому production bundle пока не включён в ZIP.

Актуальный checkpoint и QA: `docs/PHASE-6-VISUAL-COMPONENT-INSTALL.md`, `docs/QA-PHASE-6.md`.


## Почта VAPELAB

Единый ящик `info@vapelab.bond` подключается к CRM через SMTP (отправка) и IMAP (входящие письма). Почтовый сервер разворачивается отдельно от CRM с Docker Mailserver; письма, состояние Dovecot/Postfix и DKIM-ключи хранятся в `mail-server/docker-data/` и не должны попадать в архивы приложения или Git.

Полная инструкция по DNS, PTR, сертификату, портам, созданию ящика, настройке DKIM и тестам доставки находится в [`mail-server/README.md`](mail-server/README.md). В CRM раздел `Почта` доступен администраторам.
