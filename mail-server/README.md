# Почтовая инфраструктура VAPELAB

Цель: единый ящик `info@example.com` на `203.0.113.10`, SMTP для исходящих уведомлений и IMAP для чтения входящих писем в CRM (`Админка → Почта`). Почтовый сервис развёртывается отдельно от CRM через Docker Mailserver; БД CRM и веб-сервер не заменяются.

## Что нужно до установки

1. Статический публичный IPv4 `203.0.113.10`.
2. Возможность установить PTR/rDNS для IP.
3. Открытые входящие TCP-порты 25, 465, 587 и 993.
4. Разрешённый исходящий TCP/25 для доставки писем на внешние MX. Если провайдер блокирует этот порт, нужна его разблокировка или SMTP relay; исходящий порт 587 сам по себе не заменяет серверную доставку по 25.
5. Docker Engine и Docker Compose plugin.
6. DNS-панель домена `example.com`.

Официальная документация Docker Mailserver указывает, что TCP/25 нужен для межсерверной доставки, 465/587 — для авторизованной отправки клиентами, а 993 — для защищённого IMAP. Исходящая доставка напрямую также использует порт 25. См. https://docker-mailserver.github.io/docker-mailserver/latest/config/security/understanding-the-ports/.

## 1. DNS и PTR

Сначала добавь записи в DNS-зону домена:

| Тип | Имя | Значение | Приоритет |
|---|---|---|---:|
| A | `mail` | `203.0.113.10` | — |
| MX | `@` | `mail.example.com` | `10` |

Если у домена уже есть MX-записи, проверь, не обслуживают ли они существующую почту. Не удаляй текущие MX, пока не решил, что вся почта должна перейти на новый сервер.

В панели хостинг-провайдера/VPS для IP `203.0.113.10` установи PTR (reverse DNS):

`mail.example.com`

После этого должны одновременно выполняться условия:

- `mail.example.com` → `203.0.113.10` (A);
- `203.0.113.10` → `mail.example.com` (PTR);
- MX домена указывает на `mail.example.com`.

PTR не устанавливается в обычной DNS-зоне домена — его задаёт владелец IP-адреса, то есть VPS-провайдер.

SPF (если в DNS ещё нет SPF для корня домена):

`v=spf1 ip4:203.0.113.10 ~all`

Если SPF TXT уже существует, не создавай второй SPF. Объедини разрешённые источники отправки в одну запись. Сначала используй `~all`; после проверки всех исходящих источников можно перейти к `-all`.

DMARC, начальный мониторинговый режим:

- тип: `TXT`
- имя: `_dmarc`
- значение: `v=DMARC1; p=none; rua=mailto:info@example.com; adkim=r; aspf=r; pct=100`

DKIM пока не добавляй: публичный ключ будет сгенерирован на сервере после первого запуска DMS. Не придумывай значение ключа.

Не создавай AAAA для `mail`, если IPv6 на VPS и в почтовом контейнере отдельно не настроен и не проверен.

## 2. Проверка VPS до запуска

Скопируй каталог `mail-server` на VPS. Перейди в него и выполни:

```bash
chmod +x preflight.sh check-mail.sh
sudo ./preflight.sh
```

Скрипт проверяет Docker/Compose, DNS, локальные конфликты портов и исходящий TCP/25. Если порт занят другим Postfix/Exim/Mailcow или другой службой — сначала выясни, кто его использует. Не останавливай существующий почтовый сервис вслепую: сначала проверь, не обслуживает ли он другие домены.

Если TCP/25 наружу не работает, обратись к провайдеру VPS с запросом разблокировать исходящие подключения TCP/25. Если он откажет, потребуется внешний authenticated SMTP relay; тогда `SMTP_URL` приложения и `RELAY_*` настройки DMS должны быть согласованы с выбранным провайдером.

В UFW, если он используется, разреши входящие порты:

```bash
sudo ufw allow 25/tcp
sudo ufw allow 465/tcp
sudo ufw allow 587/tcp
sudo ufw allow 993/tcp
```

Кроме UFW, входящие порты должны быть разрешены в сетевом firewall панели VPS.

## 3. TLS-сертификат

DMS настроен на `SSL_TYPE=letsencrypt` и использует сертификат для `mail.example.com` из `/etc/letsencrypt` хост-сервера. Перед запуском контейнера выпусти сертификат, например через уже работающий ACME/Caddy/Certbot на VPS.

Если используется Certbot и HTTP-порт 80 свободен, можно применить standalone challenge:

```bash
sudo certbot certonly --standalone -d mail.example.com
```

Если порт 80 занят сайтом или reverse proxy, НЕ останавливай сайт. Используй webroot соответствующего веб-сервера или DNS-01 challenge у своего DNS-провайдера. Убедись, что сертификат и ключ существуют:

```bash
sudo test -s /etc/letsencrypt/live/mail.example.com/fullchain.pem && echo CERT_OK
sudo test -s /etc/letsencrypt/live/mail.example.com/privkey.pem && echo KEY_OK
```

Если сертификаты хранятся не в `/etc/letsencrypt`, измени соответствующий bind mount в `compose.yaml` на фактический каталог, сохранив путь `/etc/letsencrypt` внутри контейнера. DMS требует монтировать весь каталог сертификатов, так как `live/` обычно содержит symlink в `archive/`. Официальная инструкция: https://docker-mailserver.github.io/docker-mailserver/latest/config/security/ssl/.

## 4. Запуск сервера и создание ящика

Только после DNS, PTR, доступного сертификата и устранения конфликтов портов:

```bash
docker compose pull
docker compose up -d
```

Проверь состояние контейнера:

```bash
docker ps --filter name=mailserver
```

Создай единственный основной почтовый аккаунт. Команда запросит пароль скрытым вводом; не добавляй пароль последним аргументом, чтобы он не сохранился в истории команд:

```bash
docker exec -it mailserver setup email add info@example.com
```

Сгенерируй DKIM RSA-2048 ключ и DNS-запись:

```bash
docker exec -it mailserver setup config dkim domain example.com
```

Посмотри созданный файл `mail.txt`:

```bash
sudo find ./docker-data/dms/config -type f -name mail.txt -print -exec cat {} \;
```

Добавь TXT-запись в DNS. Имя:

`mail._domainkey`

Значение — всё содержимое `mail.txt`, без изменения публичного ключа. Если панель DNS принимает обычную строку, перенеси содержимое TXT без имени зоны и без синтаксиса BIND-скобок. После публикации проверь `dig TXT mail._domainkey.example.com`.

Поскольку используется Rspamd DKIM signing, в конфигурации DMS включён `ENABLE_RSPAMD=1`, а OpenDKIM выключен. Это штатный вариант из документации DMS: https://docker-mailserver.github.io/docker-mailserver/latest/config/best-practices/dkim_dmarc_spf/.

После генерации ключа и настройки DNS перезапусти контейнер:

```bash
docker compose restart mailserver
```

## 5. Подключение CRM

В корневом `.env` проекта CRM (НЕ в `mail-server/mailserver.env`) укажи:

```dotenv
SMTP_URL=smtps://info%40example.com:URL_ENCODED_PASSWORD@mail.example.com:465
MAIL_FROM=info@example.com
MAILBOX_ADDRESS=info@example.com
MAILBOX_IMAP_URL=imaps://info%40example.com:URL_ENCODED_PASSWORD@mail.example.com:993
MAIL_HOST=mail.example.com
MAIL_DOMAIN=example.com
MAIL_SERVER_IP=203.0.113.10
MAIL_DKIM_SELECTOR=mail
```

`URL_ENCODED_PASSWORD` — пароль ящика, закодированный для URL. Символы `@`, `:`, `/`, `#`, `%`, `?` и пробелы должны быть percent-encoded. Для кодирования без вывода исходного пароля используй:

```bash
python3 -c 'import getpass,urllib.parse; print(urllib.parse.quote(getpass.getpass("Пароль ящика: "), safe=""))'
```

Вставь получившуюся строку вместо `URL_ENCODED_PASSWORD` в обеих переменных. Не присылай пароль в чат, не помещай его в Git и не добавляй в `mailserver.env`.

На сервере проекта установи зависимости и перезапусти CRM согласно её текущему процесс-менеджеру:

```bash
npm install
npm run check
```

Затем выполни обычный restart приложения (PM2/systemd — согласно фактическому способу запуска).

В CRM открой `Работа → Почта`. Раздел доступен только ролям `superadmin` и `admin`. Он использует IMAP для просмотра входящих, SMTP для отправки; копия исходящего письма сохраняется в папку «Отправленные», если IMAP доступен.

Важное разделение: коды входа по e-mail по-прежнему отправляются на персональный адрес учётной записи администратора/клиента. Системные уведомления о бронированиях VAPELAB направляются в центральный `info@example.com`. Уведомления о товарах и задачах, адресованные конкретным подписчикам/сотрудникам, продолжают уходить их получателям.

## 6. Проверка доставки и блокировок

С VPS выполни:

```bash
sudo ./check-mail.sh
```

С другой сети (например, с домашнего компьютера) проверь публичные соединения:

```bash
openssl s_client -connect mail.example.com:465 -servername mail.example.com -brief
openssl s_client -connect mail.example.com:993 -servername mail.example.com -brief
```

Проверь SMTP-приём по TCP/25 внешним тестом: `mail.example.com:25`. Входящий TCP/25 не тестируется проверкой порта 465.

Затем в CRM:

1. Нажми «Проверить сервер» — DNS, PTR, SMTP TLS и IMAP-аутентификация должны отображаться как успешные.
2. Нажми «Тест отправки». Письмо должно прийти на адрес, указанный в профиле текущего администратора.
3. Отправь письмо с внешнего почтового адреса на `info@example.com`, дождись его появления во «Входящих» CRM.
4. Ответь на это письмо из CRM и проверь получение ответа у внешнего адресата.
5. Отправь тестовое письмо на https://www.mail-tester.com/ и проверь SPF, DKIM, DMARC, PTR и заголовки Authentication-Results.
6. Проверь IP `203.0.113.10` по DNSBL через https://mxtoolbox.com/blacklists.aspx. Отсутствие в одной базе не гарантирует отсутствие во всех остальных.

Панель CRM показывает DNS/TLS и IMAP-вход, но не может доказать, что все внешние провайдеры принимают письма и не отправляют их в спам. Полная проверка требует реальных сообщений в обе стороны и проверки заголовков у принимающего провайдера.

## 7. Что делать, если письма блокируются

- **PTR отсутствует или неверен:** запроси у владельца IP установить PTR `mail.example.com` для `203.0.113.10`.
- **A/MX не совпадают:** исправь DNS-зону и дождись TTL/распространения DNS.
- **Порт 25 исходящий закрыт:** запроси разблокировку у VPS-провайдера. Если её не дают, настроить authenticated relay.
- **Порт 25 входящий закрыт:** почта извне не сможет доставляться на VPS напрямую; попроси провайдера открыть входящий TCP/25 либо используй MX-шлюз/почтовый сервис с маршрутизацией на VPS.
- **DKIM не проходит:** перепроверь TXT `mail._domainkey` по созданному `mail.txt`, затем проверь `Authentication-Results` в полученном письме.
- **Письмо принимается SMTP, но попадает в спам:** проверь PTR, SPF, DKIM, DMARC, HELO, контент и DNSBL. Временный `p=none` в DMARC предназначен для мониторинга; после периода наблюдения настрой политику `quarantine`/`reject`.
- **TLS не проходит:** проверь срок действия Let's Encrypt, SAN для `mail.example.com`, chain, права чтения и bind mount сертификатов.

## Компоненты

- `docker-mailserver` 17.0.0 — Postfix/Dovecot и Rspamd для SMTP/IMAP и фильтрации.
- `imapflow` — IMAP-клиент CRM.
- `mailparser` — MIME-разбор входящих сообщений.

Данные почтового ящика сохраняются отдельно в `mail-server/docker-data/dms/`. Не удаляй этот каталог: там хранятся письма и конфигурация DKIM.
