# Сервер у Cloudflare

Потрібні акаунт [Cloudflare](https://dash.cloudflare.com/), Telegram-токен, список chat ID та `DEVICE_SECRET` із [попереднього кроку](telegram.md). Назви кнопок можуть трохи відрізнятися залежно від версії панелі.

## 1. Створіть Worker

1. Відкрийте **Workers & Pages → Create application**.
2. Виберіть **Start with Hello World** або шаблон Hello World для Worker. Варіант завантаження статичного сайту для цього коду не підходить.
3. Задайте назву, наприклад `fazenda-light-monitor`, і натисніть **Deploy**.
4. Збережіть адресу `https://НАЗВА.ВАШ-ПІДДОМЕН.workers.dev` у `WORKER_URL` локального `.env`. Без `/heartbeat` у кінці.

Поки залиште стартовий код. Спершу підготуйте базу та змінні.

## 2. Створіть базу D1

1. У розділі **Storage & databases → D1 SQL Database** натисніть **Create database**.
2. Назвіть базу `light-monitor-db`.
3. Відкрийте базу → **Console**, вставте весь [schema.sql](../schema.sql) і натисніть **Execute**. Якщо редактор приймає лише одну команду, виконайте SQL-команди по черзі, кожну до `;`.
4. Поверніться у Worker → **Settings → Bindings → Add binding → D1 database**. Назва binding: **`DB`**, база: **`light-monitor-db`**. Збережіть для **Production**.

Не створюйте таблиці вручну. SQL-файл містить потрібні поля та індекси; повторне виконання не стирає стан.

## 3. Додайте змінні

Worker → **Settings → Runtime variables and secrets → Add variable** (в іншій версії панелі: **Variables and Secrets**). Для кожної виберіть **Production** і збережіть через **Add variable and deploy**.

| Key | Тип | Value |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Secret | Токен від BotFather |
| `TELEGRAM_CHAT_IDS` | Text / Variable | `["-1001234567890"]` або список ваших ID |
| `DEVICE_SECRET` | Secret | Ключ, який створила утиліта |

Для Secret увімкніть прапорець **Secret**. Значення chat ID вставляйте як JSON-список із квадратними дужками, без зовнішніх одинарних лапок з `.env`.

## 4. Вставте код і ввімкніть розклад

1. Натисніть **Edit code**, замініть вміст `worker.js` на весь [worker.js](../worker.js) із проєкту та натисніть **Deploy**.
2. У **Settings → Trigger events → Cron triggers → Add** задайте вираз `* * * * *` і збережіть. Це перевірка раз на хвилину.
3. Натисніть **Visit**. Відповідь `{"service":"light-monitor","ok":true}` означає, що HTTP працює. Вона ще не перевіряє Telegram або Cron.

Новий Cron може поширюватися до 15 хвилин. Він потрібен обов’язково: коли плата вимкнеться, нових HTTP-запитів від неї не буде.

## 5. Перевірте Telegram

У локальному `.env` мають бути ваш `WORKER_URL` і той самий `DEVICE_SECRET`. Перезапустіть утиліту, виберіть **3 → 1**. У групі має з’явитися повідомлення з позначкою **ТЕСТ**.

**3 → 3** показує стан: `last_cron` має оновлюватися, `pending` означає кількість недоставлених повідомлень. HTTP `ok` після тесту підтверджує прийняття запиту, а не доставку в Telegram.

Стан `unknown` до першого сигналу нормальний. Перший heartbeat запускає моніторинг без повідомлення. Щоб перевірити його без плати, виберіть **3 → 2**, зачекайте близько 3 хвилин, потім повторіть **2** для відновлення.

## Вартість

Для однієї плати зі щохвилинними сигналами можна почати з Workers Free і D1 Free. Платний тариф та власний домен для цього гайда не потрібні. Квоти й тарифи можуть змінюватися; перевіряйте [Workers](https://developers.cloudflare.com/workers/platform/pricing/) і [D1](https://developers.cloudflare.com/d1/platform/pricing/). Історія подій у базі накопичується, автоматичного очищення немає.

Далі: [Arduino](arduino.md).

Довідка: [Worker через Dashboard](https://developers.cloudflare.com/workers/get-started/dashboard/), [D1](https://developers.cloudflare.com/d1/get-started/), [Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
