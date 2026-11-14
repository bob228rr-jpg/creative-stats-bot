# Creative Stats Bot

Приватный Telegram-бот для загрузки snapshot-статистики из скопированного отчёта в Google Sheets. Бот сопоставляет строки только по уникальному домену, показывает предпросмотр и пишет данные после явного подтверждения.

## Что умеет

- Постоянные кнопки «Сегодня», «Вчера», «За всё время» сохраняют выбранный период между сообщениями; команды `/today`, `/yesterday`, `/total` тоже поддерживаются.
- Принимает весь отчёт одним сообщением: обычные строки, Markdown-таблицы, табы/широкие пробелы, многострочные блоки и Telegram `text_link` entities.
- Нормализует протокол, `www`, path/query и регистр, но не склеивает разные поддомены.
- Не записывает неизвестные домены, дубли в основном листе и неоднозначные строки.
- Использует полный `REPLACE snapshot`: повторная загрузка не удваивает статистику, а домены вне нового отчёта очищаются.
- Хранит pending-заявки в таблице между serverless-вызовами и защищает double click статусом/claim token.
- Ограничивает доступ одним `TELEGRAM_USER_ID`, только в private chat, и проверяет webhook secret через timing-safe comparison.
- `/start` и `/help` не обращаются к Google Sheets.

## Архитектура

- Node.js 24, ESM, Vercel Functions.
- Telegram Bot API webhook: `POST /api/telegram`.
- Google Sheets API через service account.
- Рабочие snapshots и журнал записываются одним `spreadsheets.batchUpdate`. Если batch не проходит валидацию, рабочий snapshot не применяется частично.
- Google Sheets не является транзакционной БД. Claim значительно снижает риск гонки, а повторная запись snapshot идемпотентна, но строгую exactly-once семантику под высокой параллельной нагрузкой он не обещает. Для одного разрешённого пользователя это разумный MVP; при расширении на команду pending/update locks лучше перенести в Postgres.

## Переменные окружения

Скопируйте `.env.example` только для локальной разработки. Реальные секреты не коммитьте.

Обязательные ключи:

```text
BOT_TOKEN
TELEGRAM_USER_ID
TELEGRAM_SECRET
SPREADSHEET_ID
MAIN_SHEET
GOOGLE_CLIENT_EMAIL
GOOGLE_PRIVATE_KEY
```

Опционально:

- `HEADER_ROW` — номер строки заголовков; без него бот ищет колонку `Назва потоку` в первых 20 строках.
- `STRICT_STATUS_SUM=true` — отклонять строки, где `работа + апрувы + отказы > лиды`. По умолчанию бот сохраняет их с предупреждением, поскольку бизнес-модель статусов может отличаться.

`GOOGLE_PRIVATE_KEY` в Vercel можно хранить как многострочное значение или с `\n`; оба варианта поддерживаются.

## Google Cloud и таблица

1. В Google Cloud включите Google Sheets API.
2. Создайте service account без лишних project-level ролей и получите JSON key.
3. Расшарьте только нужную Google Таблицу на `GOOGLE_CLIENT_EMAIL` с правом Editor.
4. Укажите ID таблицы из URL в `SPREADSHEET_ID`, а точное имя рабочей вкладки — в `MAIN_SHEET`.
5. В рабочем листе должна быть колонка `Назва потоку` (также распознаются `Название потока`, `Поток`, `Flow`). В каждой строке должен быть один уникальный домен.

Первый `/status` или первая загрузка создаёт недостающие колонки и служебные вкладки. Исходные колонки, чекбоксы и фильтры не удаляются. Добавленные заголовки оформляются цветом `#FF009A`, проценты — `0.0%`.

Служебные листы:

- Скрытый `СТАТА_ПО_ДНЯМ` — один upsert snapshot на `(дата Europe/Kyiv, домен)`.
- Скрытый `СТАТА_ВСЕГО` — один total snapshot на домен.
- Скрытый `ЖУРНАЛ` — старые/новые показатели и ID загрузки.
- Пересланные Telegram rich-message таблицы из CoreFlow читаются напрямую по ячейкам; изображения и подписи остаются запасным вариантом.
- `_BOT_PENDING`, `_BOT_SESSION` — скрытые технические вкладки.

## Локальная проверка

```bash
npm ci
npm test
npm run check
npm audit --omit=dev
```

## Vercel deploy

1. Свяжите репозиторий с Vercel-проектом `creative-stats-botw`.
2. Добавьте все обязательные env keys именно в Production. Не копируйте значения в issue, лог или командную строку.
3. После любого изменения env выполните новый production deployment.
4. Deployment Protection/Firewall должен пропускать публичный `POST /api/telegram`. Доступ к таблице при этом остаётся только у service account.

Обычный deploy через Git integration предпочтительнее: push в `main` запускает production deployment. Ручной вариант:

```bash
vercel link
vercel env ls
vercel deploy --prod
```

`GET /api/telegram` должен возвращать `405`. `POST` без секретного заголовка должен возвращать `403` — это штатная защита.

## Webhook

Старый `BOT_TOKEN`, который был показан на скриншотах или в чатах, сначала отзовите в BotFather и замените в Vercel. Сгенерируйте новый случайный `TELEGRAM_SECRET` отдельно от bot token.

После production deployment установите webhook из среды, где секреты уже заданы:

```bash
WEBHOOK_URL=https://creative-stats-botw.vercel.app/api/telegram npm run webhook:set
npm run webhook:info
```

Скрипты не печатают token или webhook secret. `allowed_updates` ограничены `message` и `callback_query`.

Обязательно удалите старый trigger `pollTelegram` в Google Apps Script: одновременно должен работать только webhook.

## Smoke test

1. `/start` — быстрый ответ без обращения к Google.
2. `/status` — имя таблицы, лист и строка заголовков.
3. `/today`, затем тестовый отчёт: `test.example.com 7 2 1 4`.
4. Проверить preview и нажать `Отмена`: рабочие значения не меняются.
5. Повторить и нажать `Подтвердить` на специально созданной тестовой строке.
6. Проверить main sheet, `СТАТА_ПО_ДНЯМ` и `ЖУРНАЛ`.
7. Нажать старую кнопку подтверждения повторно: бот должен сообщить, что заявка уже сохранена.

## Диагностика 403

- Ответ `Forbidden` от `POST /api/telegram` без secret header означает, что запрос дошёл до функции, а не был остановлен Deployment Protection.
- Проверьте наличие `TELEGRAM_SECRET` в Production и новый deployment после его изменения.
- `getWebhookInfo` должен показывать точный production URL; `last_error_message` и `pending_update_count` помогают увидеть ошибку доставки.
- Если секреты могли разойтись, безопаснее сгенерировать новый secret, записать его в Vercel, redeploy и повторить `setWebhook` тем же значением.
- Никогда не логируйте и не сравнивайте секреты через вывод их значений.

## Rollback

В Vercel откройте последний рабочий deployment и нажмите Promote, либо используйте `vercel rollback <deployment-id>`. Затем убедитесь, что production env не откатился к скомпрометированному token. Изменения структуры таблицы при rollback не удаляйте: старый код их игнорирует, а данные и журнал сохраняются.
