## Актуализация статуса в Phase 6

Текущий проект больше не распространяет upstream-исходник SpotlightCard внутри ZIP. Установка подготовлена через официальный registry и выполняется владельцем локально; до неё используется независимый fallback. OriginKit Hero 58 также не установлен до авторизации CLI владельца.

# Статус внешних frontend-интеграций

Контрольная проверка: 23.11.2026

## OriginKit Hero 58

Согласованный компонент: https://www.originkit.dev/sections/hero-58

Официальная страница описывает Hero 58 как Healthtech Hero with Particle Wave и указывает Gauze Blaze среди используемых компонентов. Для установки предлагается команда `npx originkit@latest add hero-58`.

В текущей сборке остаётся локальная particle-wave адаптация, а не исходный компонент OriginKit. Попытка проверить доступ к npm Registry завершилась ошибкой DNS `EAI_AGAIN registry.npmjs.org`, поэтому исходный пакет и его зависимости не были загружены, а команда установки не запускалась.

Следующий технический шаг после восстановления доступа к Registry:

1. Установить OriginKit в изолированную React/Vite-подпапку публичной витрины.
2. Проверить лицензию и файлы компонента Gauze Blaze.
3. Подключить Hero 58 с чёрно-белой палитрой VAPELAB и небольшими синими/голубыми акцентами.
4. Собрать production bundle и проверить отсутствие критической CDN-зависимости.

## React Bits

Витрина содержит React Bits SpotlightCard-адаптацию, которая импортирует React runtime по browser ESM import map с `esm.sh`. Это не локальная production-сборка React и не полное внедрение всех выбранных компонентов.

Пока npm Registry недоступен, не добавлять ложные заявления, что React Bits/OriginKit установлены локально. После восстановления сети требуется вынести зависимости в build pipeline и перевести Spotlight Card, Accordion/навигационные эффекты на локальные модули.

Условия лицензии React Bits должны оставаться в `docs/licenses/REACT-BITS-NOTICE.md` при сохранении соответствующих компонентов.


## Обновление по Phase 5 (23.11.2026)

Старый browser import map через `esm.sh` удалён. Добавлен отдельный `storefront-react/` на React/Vite; официальный-source React Bits SpotlightCard находится в этой подпапке и попадёт в локальный production bundle после `npm run setup:storefront`. Пока bundle не собран, SSR-карточки используют небольшой локальный progressive fallback.

OriginKit Hero 58 всё ещё не скачан. На машине разработки нужно выполнить шаги из `storefront-react/ORIGINKIT-HERO58.md`; до этого видимый Hero — собственная canvas-адаптация, а не официальный исходник.
