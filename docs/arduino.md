# Запис прошивки через Arduino IDE

Потрібні плата, USB-кабель із передаванням даних, адреса готового Worker і `DEVICE_SECRET`.

## 1. Установіть Arduino IDE і бібліотеки

1. Завантажте [Arduino IDE](https://www.arduino.cc/en/software/).
2. У **Settings / Preferences → Additional Boards Manager URLs** додайте:
   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. У **Boards Manager** знайдіть **esp32 by Espressif Systems** та встановіть. У цьому проєкті перевірено версію **3.3.12**.
4. У **Library Manager** знайдіть **WiFiManager by tzapu** та встановіть **2.0.17**, з якою перевірено прошивку. Інші потрібні бібліотеки входять до пакета ESP32.

Джерело інструкції встановлення пакета: [Espressif](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html).

## 2. Заповніть конфігурацію

У папці `esp32_firmware/FazendaMonitor` зробіть копію `config.example.h` з назвою **`config.h`**. Відредагуйте тільки рядки зі значеннями, залиште лапки й крапки з комою.

| Поле | Що вставити |
| --- | --- |
| `WORKER_URL` | Ваш `https://НАЗВА.ПІДДОМЕН.workers.dev` без завершального `/` |
| `DEVICE_SECRET` | Той самий ключ, що збережений у Cloudflare |
| `SETUP_AP_PASSWORD` | Придуманий вами пароль мережі плати, 8–63 ASCII-символи |

Пароль роутера тут не потрібний. Його введете через телефон. Telegram-токен теж залишається на сервері.

`.env` читає лише Python-утиліта на комп’ютері. ESP32 використовує `config.h`; зміна одного файлу не оновлює інший.

## 3. Відкрийте прошивку та виберіть плату

1. Підключіть ESP32 до комп’ютера.
2. У **File → Open** відкрийте `esp32_firmware/FazendaMonitor/FazendaMonitor.ino`. Поруч мають бути вкладки `config.h` і `trusted_roots.h`.
3. У **Select Board → Select other board and port…** виберіть **DOIT ESP32 DEVKIT V1** та USB-порт плати. Для сумісної класичної ESP32-WROOM-32 альтернативою є **ESP32 Dev Module**.
4. Або скористайтеся **Tools → Board** і **Tools → Port**. На Mac меню Tools знаходиться в системному рядку вгорі екрана; у повноекранному режимі наведіть туди курсор.

Порт зазвичай містить `usbserial`, `SLAB_USBtoUART` або `usbmodem`. Bluetooth, колонки та `debug-console` не є портами цієї плати. Якщо потрібного порту немає, спробуйте інший кабель. [Інші причини](troubleshooting.md).

## 4. Перевірте і запишіть

1. Натисніть **✓ Verify**. Перший запуск може тривати кілька хвилин.
2. Після успішної компіляції натисніть **→ Upload**.
3. Якщо довго бачите `Connecting…`, затисніть **BOOT** і відпустіть, коли почнеться запис.
4. Дочекайтеся `Hash of data verified` та `Hard resetting via RTS pin…`. Це успішний запис і перезапуск.

У перевіреній збірці програма займає близько 92% відведеної flash-пам’яті. Якщо компіляція успішна, вона вміщується; цей відсоток не означає зайняту оперативну пам’ять.

Папку на плату як на флешку не копіюють. Arduino IDE перетворює код на прошивку й записує її через USB.

Далі: [Wi-Fi з телефона](wifi.md).
