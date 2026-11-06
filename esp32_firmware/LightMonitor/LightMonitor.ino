// Автономний монітор світла вдома. Плата: класична ESP32 DevKit V1 / ESP32-WROOM-32.
// Після прошивання комп'ютер не потрібний: достатньо USB-живлення та Wi-Fi.
#include <WiFi.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <time.h>
#include "config.h"
#include "trusted_roots.h"

constexpr uint32_t HEARTBEAT_MS = 60000;
constexpr uint32_t RETRY_MS = 15000;
constexpr int WIFI_SETUP_BUTTON_PIN = 0; // BOOT на класичній DevKit V1; утримувати після запуску.
WebServer statusServer(80);
WiFiManager wifiManager;
uint32_t nextAttempt = 0, offlineSince = 0, buttonSince = 0, lastSuccess = 0;
bool wasConnected = false, hasSuccess = false, offlineTracking = false;
int lastHttpCode = 0;

// Сторінка доступна лише в локальній мережі, секрети й пароль Wi-Fi не показуємо.
void showStatus() {
  String page = "<!doctype html><html lang='uk'><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<meta http-equiv='refresh' content='10'><title>Світло вдома</title>"
    "<body style='font:20px sans-serif;padding:24px'><h1>🏡 Світло вдома</h1>";
  page += WiFi.status() == WL_CONNECTED ? "<p>Wi-Fi підключено ✅</p>" : "<p>Wi-Fi недоступний</p>";
  page += "<p>IP: " + WiFi.localIP().toString() + "</p>";
  if (hasSuccess) page += "<p>Сервер прийняв сигнал " + String((millis()-lastSuccess)/1000) + " с тому.</p>";
  else page += "<p>Успішного сигналу серверу ще не було.</p>";
  page += "<p>Останній код HTTP: " + String(lastHttpCode) + " (200 = успіх, 0 = ще немає відповіді).</p>";
  page += "<p>Інтервал сигналів: 60 секунд.</p><p>Інший Wi-Fi: утримуйте BOOT 3 секунди після запуску плати.</p></body></html>";
  statusServer.sendHeader("Cache-Control", "no-store");
  statusServer.send(200, "text/html; charset=utf-8", page);
}

// Налаштування Wi-Fi зберігає WiFiManager у flash-пам'яті ESP32.
// Портал працює до 3 хвилин. Далі перезапуск і нова спроба збереженої мережі:
// плата не застрягне в режимі налаштування після тимчасового збою роутера.
void configureWifi(bool forcePortal) {
  statusServer.stop();
  wifiManager.setDebugOutput(false); // Не друкуємо паролі та секрети.
  wifiManager.setHostname("light-monitor");
  wifiManager.setConnectTimeout(20);
  wifiManager.setConfigPortalTimeout(180);
  Serial.println("Wi-Fi setup: LightMonitor-Setup; open http://192.168.4.1");
  bool ok = forcePortal
    ? wifiManager.startConfigPortal("LightMonitor-Setup", SETUP_AP_PASSWORD)
    : wifiManager.autoConnect("LightMonitor-Setup", SETUP_AP_PASSWORD);
  if (!ok) {
    Serial.println("Wi-Fi timeout; restarting.");
    delay(1000);
    ESP.restart();
  }
}

// HTTPS із перевіркою довіреного сертифіката. setInsecure() не використовуємо.
bool sendHeartbeat() {
  if (time(nullptr) < 1700000000) {
    Serial.println("Waiting for NTP time for HTTPS.");
    return false;
  }
  WiFiClientSecure tls;
  tls.setCACert(TRUSTED_ROOTS);
  tls.setHandshakeTimeout(10);
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  http.setUserAgent("LightMonitorESP32/1.0");
  // Перенаправлення не дозволяємо: секрет має потрапляти тільки нашому Worker.
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  if (!http.begin(tls, String(WORKER_URL) + "/heartbeat")) return false;
  http.addHeader("Authorization", String("Bearer ") + DEVICE_SECRET);
  lastHttpCode = http.POST(String(""));
  String body = lastHttpCode == 200 ? http.getString() : String("");
  http.end();
  Serial.printf("Heartbeat HTTP: %d\n", lastHttpCode);
  // Worker повертає компактний JSON. Помилкову HTML-сторінку не рахуємо успіхом.
  return lastHttpCode == 200 && body.indexOf("\"ok\":true") >= 0;
}

void setup() {
  Serial.begin(115200);
  pinMode(WIFI_SETUP_BUTTON_PIN, INPUT_PULLUP);
  WiFi.setHostname("light-monitor");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  configureWifi(false);
  // Годинник потрібен для перевірки терміну дії сертифіката HTTPS.
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com", "time.google.com");
  statusServer.on("/", HTTP_GET, showStatus);
  statusServer.begin();
  MDNS.begin("light-monitor");
  MDNS.addService("http", "tcp", 80);
  Serial.print("Status page: http://");
  Serial.println(WiFi.localIP());
}

void loop() {
  statusServer.handleClient();
  uint32_t now = millis();
  if (digitalRead(WIFI_SETUP_BUTTON_PIN) == LOW) {
    if (!buttonSince) buttonSince = now;
    if (uint32_t(now-buttonSince) >= 3000) {
      configureWifi(true);
      ESP.restart();
    }
  } else buttonSince = 0;

  if (WiFi.status() != WL_CONNECTED) {
    wasConnected = false;
    if (!offlineTracking) { offlineSince = now; offlineTracking = true; }
    // Автореконект має хвилину; далі пропонуємо телефонний портал.
    if (uint32_t(now-offlineSince) >= 60000) {
      configureWifi(false);
      ESP.restart();
    }
    delay(10);
    return;
  }
  offlineTracking = false;
  // Перший сигнал після запуску/повернення Wi-Fi не чекає хвилинного таймера.
  if (!wasConnected) { wasConnected = true; nextAttempt = now; }
  if (int32_t(now-nextAttempt) >= 0) {
    bool ok = sendHeartbeat();
    if (ok) { hasSuccess = true; lastSuccess = millis(); }
    // За нормальної роботи раз на хвилину від початку запиту; при збої — через 15 с.
    nextAttempt = ok ? now + HEARTBEAT_MS : millis() + RETRY_MS;
  }
  delay(10);
}
