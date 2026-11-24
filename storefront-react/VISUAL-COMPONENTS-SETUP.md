# Установка официальных визуальных компонентов VAPELAB

Витрина уже содержит рабочую локальную адаптацию Hero и собственный fallback-световой эффект. Официальные исходники OriginKit и React Bits должны быть получены через авторизованные CLI на компьютере владельца. Не передавайте файлы `~/.originkit/auth.json`, API-ключи или `.originkit` в архив/чат.

## 1. Требования

- Node.js 22.12+;
- npm и доступ к `registry.npmjs.org`;
- возможность открыть браузер для OAuth OriginKit.

## 2. Оригинальный OriginKit Hero 58

В PowerShell из корня проекта: 

```powershell
cd storefront-react
.\scripts\install-originkit-hero58.ps1
```

После установки адаптер `src/components/OriginKitHeroAdapter.js` ищет модуль по пути, содержащему `hero-58` или `hero58`, и использует его default export либо named export `Hero58`/`Hero`. Если структура экспорта отличается, компонент останется на fallback до ручного подключения после осмотра исходников.

Скрипт запускает `npx originkit@latest login`, затем `npx originkit@latest add hero-58`. CLI использует браузерную OAuth 2.1 + PKCE сессию; секреты хранятся вне проекта. Страница Hero 58 указывает `Gauze Blaze` как зависимый компонент.

После скачивания исходников: 

```powershell
npm run inspect:originkit
```

Нужно проверить реальный компонент, экспорт, props, импорт Gauze Blaze и дополнительные зависимости. Только после этого Hero будет подключён в `src/main.js`; имя экспорта или структуру файлов заранее не предполагаем.

## 3. Официальный React Bits Spotlight Card

В PowerShell из корня проекта: 

```powershell
cd storefront-react
.\scripts\install-reactbits.ps1
```

Скрипт временно включает shadcn-конфигурацию и выполняет: 

```powershell
npx shadcn@latest add @react-bits/SpotlightCard-JS-CSS
```

После установки исходник будет находиться в `src/components/visuals/`. `SpotlightAdapter.js` ищет модуль с именем Spotlight Card и использует его, если он установлен; до установки остаётся независимый fallback VAPELAB. Конфигурация OriginKit `components.json` восстанавливается в блоке `finally`, в том числе при ошибке CLI.

## 4. Production build

После установки React и Vite зависимостей из корня проекта: 

```cmd
npm run setup:storefront
```

Скрипт создаёт production bundle в `public/react-app/`. Это генерируемые файлы; их не редактировать вручную. После сборки перезапустите Node backend и проверьте `/`, `/tabak`, `/product/<slug>` и `/crm`.

## 5. Лицензии

React Bits публикует исходный код под `MIT + Commons Clause`; коммерческое использование в приложении разрешено, но сама лицензия ограничивает дальнейшее распространение компонентов как отдельных компонентов/наборов. Поэтому исходник официального Spotlight Card не хранится в этом передаваемом ZIP: владелец загружает его напрямую через официальный реестр в свою рабочую копию. См. https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md.

OriginKit Hero 58 также загружается через авторизованный CLI; не копируйте чужие учетные данные и не включайте токены в репозиторий.
