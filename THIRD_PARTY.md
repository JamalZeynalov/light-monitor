# Сторонні компоненти

- [Arduino-ESP32](https://github.com/espressif/arduino-esp32) та [WiFiManager](https://github.com/tzapu/WiFiManager) встановлюються через Arduino IDE, їхній код не скопійовано в цей репозиторій.
- [python-dotenv](https://github.com/theskumar/python-dotenv) встановлюється через pip.
- `trusted_roots.h` містить публічні кореневі сертифікати з [Google Trust Services](https://pki.goog/roots.pem) та [ISRG Root X1](https://letsencrypt.org/certs/isrgrootx1.pem). Це довірені CA для HTTPS, не приватні ключі. Джерела зафіксовані 2026-11-05; згодом файл може потребувати оновлення.
