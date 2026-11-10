#!/usr/bin/env python3
"""Локальна утиліта налаштування. Залежність: python-dotenv.
Запуск: python3 setup_helper.py
Налаштування читаються з .env поруч із цим файлом без запитів на введення.
"""
import os
from dotenv import load_dotenv
import json
import secrets
import ssl
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError


# Явний шлях дозволяє запускати утиліту з будь-якої папки.
ENV_FILE = Path(__file__).resolve().parent / '.env'
load_dotenv(ENV_FILE)


def setting(name):
    """Повертає налаштування або показує назву відсутньої змінної без секретів."""
    value = os.environ.get(name, '').strip()
    if not value:
        raise ValueError(f'Заповніть {name} у файлі {ENV_FILE}')
    return value


# Python з python.org на macOS може не мати власного CA-файлу.
# Додаємо системні довірені сертифікати; перевірка HTTPS залишається увімкненою.
TLS_CONTEXT = ssl.create_default_context()
SYSTEM_CA_FILE = Path('/etc/ssl/cert.pem')
if sys.platform == 'darwin' and SYSTEM_CA_FILE.is_file():
    TLS_CONTEXT.load_verify_locations(cafile=str(SYSTEM_CA_FILE))


def api(url, token=None, method="GET"):
    # Cloudflare відхиляє стандартний User-Agent urllib кодом 1010.
    # Називаємо наш клієнт явно; перевірка HTTPS та авторизація зберігаються.
    headers = {"User-Agent": "LightMonitorSetup/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(url, headers=headers, method=method)
    with urlopen(request, timeout=20, context=TLS_CONTEXT) as response:
        return json.load(response)


def chat_ids():
    print("Кожен отримувач має написати /start вашому боту. Для групи надішліть /start@імʼя_бота.")
    token = setting("TELEGRAM_BOT_TOKEN")
    result = api("https://api.telegram.org/bot" + token + "/getUpdates")
    if not result.get("ok"):
        print("Telegram не повернув успішної відповіді.")
        return
    ids = set()
    for update in result.get("result", []):
        for field in ("message", "channel_post", "edited_message"):
            chat = update.get(field, {}).get("chat", {})
            if "id" in chat:
                ids.add(chat["id"])
    print("Знайдені chat ID:", json.dumps(sorted(ids)))
    print("Скопіюйте у TELEGRAM_CHAT_IDS лише ID потрібних отримувачів.")
    if not ids:
        print("Надішліть боту нове повідомлення й повторіть. Інший сервіс бота може забирати updates.")


def worker_url():
    base = setting("WORKER_URL").rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".workers.dev") or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password or parsed.port:
        raise ValueError("Потрібна коренева HTTPS-адреса вашого Worker на workers.dev")
    return base


def last_signal():
    """Читає час останнього прийнятого сигналу та стан монітора."""
    result = api(worker_url() + "/status", setting("DEVICE_SECRET"))
    seen = result["last_seen"]
    if seen is None:
        print("Сервер ще не отримував сигналів.")
        return
    stamp = datetime.fromtimestamp(seen, ZoneInfo("Europe/Kyiv"))
    seconds = max(0, result["server_time"] - seen)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        age = f"{hours} год {minutes} хв"
    elif minutes:
        age = f"{minutes} хв {seconds} с"
    else:
        age = f"{seconds} с"
    print(f"Останній сигнал: {stamp:%d.%m.%Y %H:%M:%S} (Київ), {age} тому.")
    status = {"up": "на зв’язку", "down": "сигнал зник"}.get(result["status"], "очікування")
    print(f"Стан за даними монітора: {status}.")


def server():
    base = worker_url()
    token = setting("DEVICE_SECRET")
    while True:
        print("\n1 — тестове повідомлення Telegram; 2 — один сигнал ESP32; 3 — стан сервера; 0 — назад")
        choice = input("> ").strip()
        if choice == "0":
            return
        routes = {"1": ("/test", "POST"), "2": ("/heartbeat", "POST"), "3": ("/status", "GET")}
        if choice not in routes:
            continue
        route, method = routes[choice]
        result = api(base + route, token, method)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if choice == "1":
            print("Запит прийнято. Перевірте Telegram; HTTP ok сам по собі не підтверджує доставку.")
        if choice == "2":
            print("Один сигнал надіслано. Тепер не надсилайте нових 3 хвилини: має прийти тривога.")
            print("Після тривоги повторіть пункт 2: має прийти повідомлення про відновлення.")
        if choice == "3":
            last = result.get("last_cron")
            if last is None or time.time() - last > 180:
                print("Cron ще не запускався або давно не працював. Перевірте Cron Triggers.")


def main():
    while True:
        print("\n1 — створити DEVICE_SECRET; 2 — знайти Telegram chat ID; 3 — перевірити Worker; 4 — час останнього сигналу; 0 — вихід")
        choice = input("> ").strip()
        try:
            if choice == "0":
                return
            if choice == "1":
                print("DEVICE_SECRET (збережіть у менеджері паролів і Cloudflare Secret):")
                print(secrets.token_hex(32))
            elif choice == "2":
                chat_ids()
            elif choice == "3":
                server()
            elif choice == "4":
                last_signal()
        except HTTPError as error:
            print(f"HTTP {error.code}. 401: перевірте ключ/токен; 500: перевірте Worker Logs.")
            if error.code == 403:
                print("Доступ заборонено. Якщо ви щойно оновили утиліту, закрийте її та запустіть знову.")
            if error.code == 409:
                print("Telegram: перевірте, чи цей бот не використовується іншим сервісом/webhook.")
        except URLError as error:
            if isinstance(error.reason, ssl.SSLCertVerificationError):
                print("Помилка довіри до HTTPS-сертифіката. Потрібно перевірити довірені сертифікати Python.")
            else:
                print("Мережевий збій (" + type(error.reason).__name__ + "). Перевірте з'єднання та повторіть.")
        except TimeoutError:
            print("Сервер не відповів за 20 секунд. Повторіть спробу.")
        except ValueError as error:
            print(str(error))
        except OSError as error:
            print(type(error).__name__ + ": перевірте введені дані та повторіть.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nЗавершено.")
