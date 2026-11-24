# OriginKit Hero 58: установка и подключение

Согласованный компонент: https://www.originkit.dev/sections/hero-58. Страница указывает `Gauze Blaze` и команду `npx originkit@latest add hero-58`.

## Установка на Windows

Откройте PowerShell в корне проекта:

```powershell
cd .\storefront-react
powershell -ExecutionPolicy Bypass -File .\scripts\install-originkit-hero58.ps1
npm run inspect:originkit
```

CLI открывает авторизацию владельца в браузере. Не передавайте файл `~/.originkit/auth.json`, токены и OAuth-сессию и не включайте их в архив.

## Как подключается компонент

- `src/components/OriginKitHeroAdapter.js` ищет локальные JS/JSX-модули в `src/components/originkit/`.
- Если в файле, где путь содержит `hero-58`/`hero58`, найден default export либо `Hero58`/`Hero` React component, адаптер использует его.
- Пока исходника нет или экспорт отличается, остаётся текущая локальная particle-wave адаптация `public/hero-58-visual.js`.

Адаптер намеренно не угадывает props неизвестного компонента. После установки просмотрите вывод `npm run inspect:originkit` и откройте локальный файл Hero 58. Если исходник использует обязательные props или необычный named export, их нужно подключить вручную по фактическому коду.

## React Bits Spotlight Card

```powershell
cd .\storefront-react
powershell -ExecutionPolicy Bypass -File .\scripts\install-reactbits.ps1
```

Компонент устанавливается владельцем напрямую из официального registry. После установки `SpotlightAdapter.js` обнаруживает его в `src/components/visuals/`. До установки используется независимый fallback VAPELAB. Upstream-исходник не включается в ZIP.

## Production build

После установки официальных компонентов и при доступе к npm Registry:

```powershell
cd .\storefront-react
npm install
npm run build
cd ..
npm start
```

Из корня также доступна команда `npm run setup:storefront`, которая устанавливает зависимости и собирает bundle. Проверить `/`, `/tabak`, `/product/<slug>` и `/crm`.

Нельзя считать оригинальный Hero 58 установленным до успешного CLI-запроса, просмотра скачанных исходников, Vite build и визуальной проверки в браузере.
