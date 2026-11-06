// Cloudflare Worker для ОДНІЄЇ ESP32. Без бібліотек і npm install.
// Вставте файл у Workers & Pages -> light-monitor -> Edit code -> Deploy.
// D1 binding: DB. Secrets: DEVICE_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS.
// TELEGRAM_CHAT_IDS — JSON-масив, наприклад [123456789,987654321].
// Cron: * * * * * (щохвилини).
// ESP32: POST /heartbeat, заголовок Authorization: Bearer <DEVICE_SECRET>.
// Тіло запиту не потрібне. Час визначає сервер, а не годинник ESP32.
// До першого heartbeat моніторинг не активний. Перша активація тиха.
// Відключення інтернету і живлення тут НЕ розрізняються.

const OFFLINE_AFTER_SECONDS = 120; // Тривога після 2 хвилин без сигналу.
const SEND_TIMEOUT_MS = 8000;
const MAX_DELIVERIES_PER_RUN = 8; // Решта отримувачів — у наступному циклі.

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function recipients(env) {
  const ids = JSON.parse(env.TELEGRAM_CHAT_IDS || "[]");
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 ||
      ids.some(id => !/^-?\d+$/.test(String(id)) || String(id) === "0")) {
    throw new Error("TELEGRAM_CHAT_IDS: потрібен JSON-масив із 1–10 числових chat ID");
  }
  return [...new Set(ids.map(String))];
}

function validate(env) {
  if (!env.DB) throw new Error("Не додано D1 binding із назвою DB");
  if (!env.DEVICE_SECRET || env.DEVICE_SECRET.length < 32) {
    throw new Error("DEVICE_SECRET має містити щонайменше 32 символи");
  }
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Не задано TELEGRAM_BOT_TOKEN");
  recipients(env);
}

// Хеші порівнюємо без дострокового виходу; ключ не передаємо в URL.
async function authorized(request, env) {
  if (!env.DEVICE_SECRET || env.DEVICE_SECRET.length < 32) return false;
  const supplied = request.headers.get("Authorization") || "";
  if (supplied.length > 256) return false;
  const enc = new TextEncoder();
  const hashes = await Promise.all([supplied, `Bearer ${env.DEVICE_SECRET}`]
    .map(value => crypto.subtle.digest("SHA-256", enc.encode(value))));
  const a = new Uint8Array(hashes[0]);
  const b = new Uint8Array(hashes[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// Транзакція не дозволяє двом одночасним heartbeat створити дві події up.
async function heartbeat(env, now) {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO events(kind, created_at)
      SELECT 'up', ? FROM monitor WHERE id=1 AND status='down'`).bind(now),
    env.DB.prepare(`UPDATE monitor SET status='up',
      last_seen=MAX(COALESCE(last_seen, 0), ?) WHERE id=1`).bind(now),
  ]);
}

// Два одночасні Cron також не створять повторне повідомлення down.
async function checkOffline(env, now) {
  const cutoff = now - OFFLINE_AFTER_SECONDS;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO events(kind, created_at)
      SELECT 'down', ? FROM monitor
      WHERE id=1 AND status='up' AND last_seen<=?`).bind(now, cutoff),
    env.DB.prepare(`UPDATE monitor SET status='down'
      WHERE id=1 AND status='up' AND last_seen<=?`).bind(cutoff),
    env.DB.prepare("UPDATE monitor SET last_cron=? WHERE id=1").bind(now),
  ]);
}

// Додавайте нові тексти до відповідного списку. Картинки не використовуємо.
const POWER_ON_MESSAGES = [
  "💡 Світло є! Дайте батареям 🔋 зарядитись і ставте стірку 🧺",
  "💡 Світло є! Фазенда знову в строю! Вмикайте бойлер і готуйте їсти 🥘",
  "💡 Світло повернулося! Фазенда набирається сил 🔋. Павербанки — на зарядку, чайник — на старт!",
];
const POWER_OFF_MESSAGES = [
  "🌚 Світло вимкнули. Фазенда перейшла в романтичний режим 🕯",
  "🌚 Світло пішло погуляти. Миші 🐀 перегризли дроти, єноти лагодять 🦝!",
  "🌚 Світло поки що продають в Румунію. Бойлери й пралку вимикаємо! 🏡",
];

async function eventText(event) {
  const choices = event.kind === "test"
    ? [...POWER_ON_MESSAGES, ...POWER_OFF_MESSAGES]
    : event.kind === "up" ? POWER_ON_MESSAGES : POWER_OFF_MESSAGES;
  // Псевдовипадковий вибір за унікальною подією: однаковий для всіх чатів
  // та повторних спроб доставки. Схему бази змінювати не потрібно.
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`${event.id}:${event.created_at}:${event.kind}`));
  const index = new DataView(digest).getUint32(0) % choices.length;
  const prefix = event.kind === "test" ? "🧪 ТЕСТ\n" : "";
  return `${prefix}${choices[index]}`;
}

// Помилка одного чату не перериває доставку іншим. HTTP 429 враховується.
async function sendTelegram(env, chatId, text) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    const result = await response.json();
    if (response.ok && result.ok === true) return { ok: true };
    const retry = Number(result.parameters?.retry_after);
    console.error("Telegram delivery failed", { chatId, httpStatus: response.status });
    return { ok: false, delay: Number.isFinite(retry) ? Math.max(60, retry) : 60 };
  } catch {
    // Не виводимо URL запиту: він містить секретний токен Telegram.
    console.error("Telegram network failure", { chatId });
    return { ok: false, delay: 60 };
  }
}

async function flushOutbox(env) {
  const ids = recipients(env);
  const { results: events } = await env.DB.prepare(
    "SELECT id FROM events WHERE queued=0 ORDER BY id LIMIT 3"
  ).all();
  for (const event of events) {
    // Унікальний ключ (event_id,chat_id) захищає від конкурентного додавання.
    const statements = ids.map(id => env.DB.prepare(
      "INSERT OR IGNORE INTO deliveries(event_id,chat_id) VALUES (?,?)"
    ).bind(event.id, id));
    statements.push(env.DB.prepare("UPDATE events SET queued=1 WHERE id=?").bind(event.id));
    await env.DB.batch(statements);
  }

  const now = Math.floor(Date.now() / 1000);
  const { results: pending } = await env.DB.prepare(`
    SELECT d.event_id, d.chat_id, e.kind, e.created_at
    FROM deliveries d JOIN events e ON e.id=d.event_id
    WHERE d.delivered_at IS NULL AND d.retry_at<=? AND d.lease_until<=?
      AND NOT EXISTS (
        SELECT 1 FROM deliveries older
        WHERE older.chat_id=d.chat_id AND older.delivered_at IS NULL
          AND older.event_id<d.event_id
      )
    ORDER BY d.event_id LIMIT ?
  `).bind(now, now, MAX_DELIVERIES_PER_RUN).all();

  // Цикл охоплює всіх вибраних отримувачів; надсилаємо паралельно, щоб
  // укластися у фоновий час HTTP Worker навіть при недоступності Telegram.
  const jobs = [];
  for (const row of pending) {
    jobs.push((async () => {
      const lease = crypto.randomUUID();
      const claim = await env.DB.prepare(`UPDATE deliveries
        SET lease_until=?, lease_token=?, attempts=attempts+1
        WHERE event_id=? AND chat_id=? AND delivered_at IS NULL
          AND lease_until<=? AND retry_at<=?
        RETURNING event_id
      `).bind(now + 90, lease, row.event_id, row.chat_id, now, now).first();
      if (!claim) return; // Цю доставку вже обробляє інший виклик Worker.
      const result = await sendTelegram(env, row.chat_id,
        await eventText({ ...row, id: row.event_id }));
      const finished = Math.floor(Date.now() / 1000);
      if (result.ok) {
        await env.DB.prepare(`UPDATE deliveries
          SET delivered_at=?, lease_until=0, lease_token=NULL
          WHERE event_id=? AND chat_id=? AND lease_token=?
        `).bind(finished, row.event_id, row.chat_id, lease).run();
      } else {
        await env.DB.prepare(`UPDATE deliveries
          SET retry_at=?, lease_until=0, lease_token=NULL
          WHERE event_id=? AND chat_id=? AND lease_token=?
        `).bind(finished + result.delay, row.event_id, row.chat_id, lease).run();
      }
    })());
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}

// Технічні помилки залишаються тільки в логах Cloudflare, без Telegram.
async function reportFailure(env, error) {
  let description = String(error?.message || error);
  for (const secret of [env.DEVICE_SECRET, env.TELEGRAM_BOT_TOKEN]) {
    if (secret) description = description.split(secret).join("[SECRET]");
  }
  description = description.slice(0, 1000);
  console.error("Monitor failure:", description);

}

export default {
  async fetch(request, env, ctx) {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/" && request.method === "GET") {
        // Це перевірка роботи HTTP, а не підтвердження налаштованого Cron.
        return json({ service: "light-monitor", ok: true });
      }
      if (!["/heartbeat", "/status", "/test"].includes(path)) {
        return json({ error: "Not found" }, 404);
      }
      const expectedMethod = path === "/status" ? "GET" : "POST";
      if (request.method !== expectedMethod) return json({ error: "Method not allowed" }, 405);
      if (!await authorized(request, env)) return json({ error: "Unauthorized" }, 401);
      validate(env);
      const now = Math.floor(Date.now() / 1000);
      if (path === "/status") {
        const state = await env.DB.prepare("SELECT status,last_seen,last_cron FROM monitor WHERE id=1").first();
        if (!state) throw new Error("База не ініціалізована: виконайте schema.sql");
        const queue = await env.DB.prepare(
          "SELECT COUNT(*) AS pending FROM deliveries WHERE delivered_at IS NULL"
        ).first();
        const unqueued = await env.DB.prepare(
          "SELECT COUNT(*) AS unqueued_events FROM events WHERE queued=0"
        ).first();
        return json({ ...state, ...queue, ...unqueued, server_time: now,
          offline_after_seconds: OFFLINE_AFTER_SECONDS });
      }
      if (path === "/heartbeat") {
        await heartbeat(env, now);
      } else {
        await env.DB.prepare("INSERT INTO events(kind,created_at) VALUES ('test',?)").bind(now).run();
      }
      // Стан уже на диску; фонову доставку за потреби продовжить наступний Cron.
      ctx.waitUntil(flushOutbox(env).catch(error => reportFailure(env, error)));
      return json({ ok: true, action: path.slice(1), server_time: now });
    } catch (error) {
      ctx.waitUntil(reportFailure(env, error));
      return json({ error: "Server error; check Worker logs" }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      validate(env);
      // Реальний час виконання: запланований запуск міг затриматися.
      await checkOffline(env, Math.floor(Date.now() / 1000));
      await flushOutbox(env);
    } catch (error) {
      await reportFailure(env, error);
      throw new Error("Monitor cron failed; check Worker logs");
    }
  },
};
