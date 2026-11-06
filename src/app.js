/**
 * Smart Plant Monitoring & IoT Control Platform Client Application
 */

// Application State
const state = {
    plants: [],
    devices: [],
    actuators: [],
    alerts: [],
    settings: {
        demoMode: false,
        irrigation: { autoMode: true, moistureThreshold: 40, durationSeconds: 8, cooldownMinutes: 30, minTankLevel: 15 },
        thingspeak: { channelId: '1729295', enabled: true, refreshIntervalSeconds: 20 }
    },
    thingspeak: {
        channel: null,
        latest: null,
        feeds: [],
        status: { status: 'Checking...', label: 'Connecting...', reason: 'Contacting ThingSpeak IoT Cloud...', isRecent: false },
        countdown: 20
    },
    latestTelemetry: [],
    activeTab: 'overview',
    alertFilter: 'all',
    analyticsRange: '24h',
    theme: 'dark'
};

// Chart instances
let liveMoistureChart = null;
let liveTempHumChart = null;
let analyticsMoistureChart = null;
let analyticsTempHumChart = null;
let analyticsLightChart = null;
let analyticsTankChart = null;

// Arduino C++ Firmware Code Samples
const FIRMWARE_HTTP = `/**
 * Smart Plant Monitoring System - ESP32 HTTP Client Firmware
 * Target: DOIT ESP32 DEVKIT V1
 * Libraries Required: DHT sensor library by Adafruit, Adafruit Unified Sensor, BH1750, ArduinoJson (v6+)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <BH1750.h>

// ---------------- WIFI & SERVER CONFIG ----------------
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* serverUrl = "http://YOUR_SERVER_IP:3000/api/v1/devices/esp32_greenhouse_01/telemetry";
const char* deviceToken = "tok_esp32_gh01_9f4b12";

// ---------------- HARDWARE PINOUTS -------------------
#define SOIL_ADC_PIN   34 // Capacitive Soil Moisture AOUT (ADC1_CH6)
#define DHTPIN         4  // DHT22 Data pin
#define DHTTYPE        DHT22
#define TRIG_PIN       12 // HC-SR04 Ultrasonic Trigger
#define ECHO_PIN       14 // HC-SR04 Ultrasonic Echo
#define PUMP_RELAY_PIN 26 // Relay Channel 1 (Active LOW or HIGH)
#define FAN_RELAY_PIN  27 // Relay Channel 2
#define LIGHT_RELAY_PIN 25 // Relay Channel 3

DHT dht(DHTPIN, DHTTYPE);
BH1750 lightMeter;

// Calibration defaults (Calibrate using Web UI!)
int dryAdc = 3200;
int wetAdc = 1400;
const int tankDepthCm = 30; // Max water depth

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\\n[ESP32] Starting Smart Plant IoT OS...");

  // Setup Relays
  pinMode(PUMP_RELAY_PIN, OUTPUT);
  pinMode(FAN_RELAY_PIN, OUTPUT);
  pinMode(LIGHT_RELAY_PIN, OUTPUT);
  digitalWrite(PUMP_RELAY_PIN, HIGH); // Default OFF (active-low)
  digitalWrite(FAN_RELAY_PIN, HIGH);
  digitalWrite(LIGHT_RELAY_PIN, HIGH);

  // Ultrasonic pins
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  // Initialize sensors
  dht.begin();
  Wire.begin(21, 22); // SDA=21, SCL=22
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    Serial.println("[BH1750] Light sensor initialized");
  }

  // Connect Wi-Fi
  connectWifi();
}

void connectWifi() {
  Serial.print("[WiFi] Connecting to: ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\n[WiFi] Connected! IP: " + WiFi.localIP().toString());
}

float measureTankLevel() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // 30ms timeout
  if (duration == 0) return 80.0; // fallback if sensor disconnected
  float distanceCm = (duration * 0.0343) / 2.0;
  float level = ((tankDepthCm - distanceCm) / tankDepthCm) * 100.0;
  return constrain(level, 0.0, 100.0);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
  }

  // 1. Read Physical Sensors
  int rawSoil = analogRead(SOIL_ADC_PIN);
  float soilMoisture = ((float)(dryAdc - rawSoil) / (float)(dryAdc - wetAdc)) * 100.0;
  soilMoisture = constrain(soilMoisture, 0.0, 100.0);

  float temp = dht.readTemperature();
  float hum = dht.readHumidity();
  float lux = lightMeter.readLightLevel();
  float tank = measureTankLevel();

  if (isnan(temp)) temp = 23.0;
  if (isnan(hum)) hum = 60.0;

  // 2. Transmit Telemetry JSON
  StaticJsonDocument<512> doc;
  doc["moisture"] = round(soilMoisture * 10) / 10.0;
  doc["rawMoistureAdc"] = rawSoil;
  doc["temperature"] = round(temp * 10) / 10.0;
  doc["humidity"] = round(hum * 10) / 10.0;
  doc["light"] = (int)lux;
  doc["tankLevel"] = (int)tank;
  doc["wifiRssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", deviceToken);

  int httpCode = http.POST(payload);
  if (httpCode == 200) {
    String response = http.getString();
    Serial.println("[HTTP 200] Telemetry sent: " + payload);

    // Parse any incoming actuator commands
    StaticJsonDocument<512> respDoc;
    deserializeJson(respDoc, response);
    JsonArray commands = respDoc["commands"];
    for (JsonObject cmd : commands) {
      const char* actId = cmd["actuatorId"];
      const char* state = cmd["state"];
      int dur = cmd["durationSeconds"] | 0;

      if (strcmp(actId, "actuator_pump_01") == 0) {
        if (strcmp(state, "ON") == 0) {
          Serial.println("[PUMP] Activating relay ON!");
          digitalWrite(PUMP_RELAY_PIN, LOW); // Active LOW
          if (dur > 0) {
            delay(dur * 1000);
            digitalWrite(PUMP_RELAY_PIN, HIGH); // Turn OFF after duration
            Serial.println("[PUMP] Auto duration complete, relay OFF");
          }
        } else {
          digitalWrite(PUMP_RELAY_PIN, HIGH);
        }
      }
    }
  } else {
    Serial.printf("[HTTP ERROR] Failed with code: %d\\n", httpCode);
  }
  http.end();

  delay(5000); // 5-second sampling interval
}`;

const FIRMWARE_MQTT = `/**
 * Smart Plant Monitoring System - ESP32 MQTT Client Firmware
 * Target: ESP32 DEVKIT V1
 * Libraries Required: PubSubClient by Nick O'Leary, ArduinoJson, DHT sensor library, BH1750
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <Wire.h>
#include <BH1750.h>

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* mqttServer = "broker.emqx.io";
const int mqttPort = 1883;
const char* deviceId = "esp32_greenhouse_01";
const char* topicTelemetry = "smartplant/esp32_greenhouse_01/telemetry";
const char* topicActuators = "smartplant/esp32_greenhouse_01/actuators";

WiFiClient espClient;
PubSubClient client(espClient);

#define SOIL_ADC_PIN   34
#define DHTPIN         4
#define DHTTYPE        DHT22
#define PUMP_RELAY_PIN 26

DHT dht(DHTPIN, DHTTYPE);
BH1750 lightMeter;

void callback(char* topic, byte* payload, unsigned int length) {
  StaticJsonDocument<256> doc;
  deserializeJson(doc, payload, length);
  const char* state = doc["state"];
  if (strcmp(state, "ON") == 0) {
    digitalWrite(PUMP_RELAY_PIN, LOW); // Turn pump ON
  } else {
    digitalWrite(PUMP_RELAY_PIN, HIGH); // Turn pump OFF
  }
}

void reconnect() {
  while (!client.connected()) {
    if (client.connect(deviceId)) {
      client.subscribe(topicActuators);
    } else {
      delay(3000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(PUMP_RELAY_PIN, OUTPUT);
  digitalWrite(PUMP_RELAY_PIN, HIGH);
  dht.begin();
  Wire.begin(21, 22);
  lightMeter.begin();

  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  client.setServer(mqttServer, mqttPort);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();

  static unsigned long lastMsg = 0;
  if (millis() - lastMsg > 5000) {
    lastMsg = millis();
    int rawSoil = analogRead(SOIL_ADC_PIN);
    float temp = dht.readTemperature();
    float hum = dht.readHumidity();
    float lux = lightMeter.readLightLevel();

    StaticJsonDocument<256> doc;
    doc["moisture"] = map(rawSoil, 3200, 1400, 0, 100);
    doc["temperature"] = temp;
    doc["humidity"] = hum;
    doc["light"] = lux;

    char buffer[256];
    serializeJson(doc, buffer);
    client.publish(topicTelemetry, buffer);
  }
}`;

// ---------------------------------------------------------------------------
// INITIALIZATION & WEBSOCKET SETUP
// ---------------------------------------------------------------------------
async function initApp() {
    setupTheme();
    setupNavigation();
    showFirmware('http');

    await fetchInitialState();
    connectWebSocket();
    initCharts();
    await fetchThingSpeakLatest();
    startThingSpeakPolling();
    renderAll();
}

function setupTheme() {
    const savedTheme = localStorage.getItem('smartplant_theme') || 'dark';
    state.theme = savedTheme;
    applyTheme(savedTheme);
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('smartplant_theme', state.theme);
    applyTheme(state.theme);
}

function applyTheme(theme) {
    const html = document.documentElement;
    const icon = document.getElementById('themeIcon');
    if (theme === 'light') {
        html.classList.remove('dark');
        document.body.classList.remove('bg-slate-950', 'text-slate-100');
        document.body.classList.add('bg-slate-100', 'text-slate-900');
        icon.textContent = '🌙';
    } else {
        html.classList.add('dark');
        document.body.classList.add('bg-slate-950', 'text-slate-100');
        document.body.classList.remove('bg-slate-100', 'text-slate-900');
        icon.textContent = '☀️';
    }
}

function setupNavigation() {
    const hash = window.location.hash.replace('#', '');
    if (hash && ['overview', 'plants', 'monitoring', 'devices', 'automation', 'analytics', 'alerts', 'hardware', 'settings'].includes(hash)) {
        switchTab(hash);
    }
}

function switchTab(tabId) {
    state.activeTab = tabId;
    window.location.hash = tabId;

    // Update active nav buttons
    document.querySelectorAll('.nav-tab').forEach(btn => {
        if (btn.getAttribute('data-nav') === tabId) {
            btn.classList.add('bg-slate-800', 'text-white');
            btn.classList.remove('text-slate-400');
        } else {
            btn.classList.remove('bg-slate-800', 'text-white');
            btn.classList.add('text-slate-400');
        }
    });

    // Toggle panes
    document.querySelectorAll('.tab-pane').forEach(pane => {
        if (pane.id === `tab-${tabId}`) {
            pane.classList.remove('hidden');
        } else {
            pane.classList.add('hidden');
        }
    });

    // Trigger chart resize if entering monitoring or analytics
    if (tabId === 'monitoring' || tabId === 'analytics') {
        setTimeout(() => {
            if (liveMoistureChart) liveMoistureChart.resize();
            if (liveTempHumChart) liveTempHumChart.resize();
            if (analyticsMoistureChart) analyticsMoistureChart.resize();
            if (analyticsTempHumChart) analyticsTempHumChart.resize();
            if (analyticsLightChart) analyticsLightChart.resize();
            if (analyticsTankChart) analyticsTankChart.resize();
        }, 50);
    }

    // Close mobile nav
    document.getElementById('mobileNavMenu').classList.add('hidden');
}

function toggleMobileNav() {
    const menu = document.getElementById('mobileNavMenu');
    menu.classList.toggle('hidden');
}

// ---------------------------------------------------------------------------
// DATA FETCHING & WEBSOCKET ENGINE
// ---------------------------------------------------------------------------
async function fetchInitialState() {
    try {
        const [stateRes, historyRes] = await Promise.all([
            fetch('/api/v1/state'),
            fetch('/api/v1/telemetry/history?range=24h&limit=60')
        ]);
        const stateData = await stateRes.json();
        const historyData = await historyRes.json();

        state.plants = stateData.plants || [];
        state.devices = stateData.devices || [];
        state.actuators = stateData.actuators || [];
        state.alerts = stateData.alerts || [];
        state.settings = stateData.settings || state.settings;
        state.latestTelemetry = historyData || [];
    } catch (err) {
        console.error('Failed to load initial state:', err);
    }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    const dot = document.getElementById('wsDot');
    const text = document.getElementById('wsText');

    ws.onopen = () => {
        dot.className = 'w-2 h-2 rounded-full bg-emerald-400';
        text.textContent = 'Live Stream';
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleSocketEvent(msg.event, msg.data);
        } catch (e) {
            console.warn('[WS Parse Error]', e);
        }
    };

    ws.onclose = () => {
        dot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
        text.textContent = 'Reconnecting...';
        setTimeout(connectWebSocket, 3000);
    };
}

function handleSocketEvent(eventName, data) {
    if (eventName === 'telemetry:update') {
        const { deviceId, record, device } = data;
        // Update device in state
        const devIndex = state.devices.findIndex(d => d.id === deviceId);
        if (devIndex >= 0) {
            state.devices[devIndex] = { ...state.devices[devIndex], ...device };
        }

        // Push telemetry
        state.latestTelemetry.push(record);
        if (state.latestTelemetry.length > 200) state.latestTelemetry.shift();

        // Update charts & cards
        updateLiveCharts(record);
        renderOverviewGauges();
        renderPlantsList();
    } else if (eventName === 'actuator:update' || eventName === 'actuator:command') {
        const act = data.actuator || data;
        const index = state.actuators.findIndex(a => a.id === act.id);
        if (index >= 0) {
            state.actuators[index] = act;
        }
        renderActuators();
    } else if (eventName === 'alert:new') {
        state.alerts.unshift(data);
        renderAlerts();
    } else if (eventName === 'device:update') {
        const index = state.devices.findIndex(d => d.id === data.id);
        if (index >= 0) state.devices[index] = data;
        else state.devices.push(data);
        renderDevices();
        renderOverviewGauges();
    } else if (eventName === 'settings:update') {
        state.settings = data;
        updateSimulationBadge();
    } else if (eventName === 'thingspeak:update') {
        if (data.channel) state.thingspeak.channel = data.channel;
        if (data.latest) state.thingspeak.latest = data.latest;
        if (data.feeds) state.thingspeak.feeds = data.feeds;
        if (data.status) state.thingspeak.status = data.status;
        state.thingspeak.countdown = 20;

        renderThingSpeakUI();
        renderOverviewGauges();
        if (data.feeds && data.feeds.length > 0) {
            updateChartsFromThingSpeakFeeds(data.feeds);
        }
    }
}

// ---------------------------------------------------------------------------
// RENDERERS
// ---------------------------------------------------------------------------
function renderAll() {
    updateSimulationBadge();
    renderOverviewKPIs();
    renderThingSpeakUI();
    renderOverviewGauges();
    renderPlantsList();
    renderActuators();
    renderDevices();
    renderAlerts();
    renderSensorList();
}

function updateSimulationBadge() {
    const badge = document.getElementById('simModeBadge');
    const toggle = document.getElementById('settingsSimToggle');
    const isDemo = state.settings.demoMode;

    if (toggle) toggle.checked = isDemo;

    if (badge) {
        if (isDemo) {
            badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-amber-500/10 text-amber-400 border-amber-500/30';
            badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span><span>HARDWARE SIMULATOR (DEMO)</span>';
        } else {
            badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
            badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>REAL HARDWARE STREAM ACTIVE</span>';
        }
    }
}

function renderOverviewKPIs() {
    const totalPlants = state.plants.length;
    const onlineDevs = state.devices.filter(d => d.status === 'online').length;
    const offlineDevs = state.devices.filter(d => d.status === 'offline').length;

    document.getElementById('kpiTotalPlants').textContent = totalPlants;
    document.getElementById('kpiOnlineDevices').textContent = onlineDevs;
    document.getElementById('kpiOfflineDevices').textContent = offlineDevs;
}

function renderOverviewGauges() {
    // Check if ThingSpeak channel data is available
    const tsLatest = state.thingspeak?.latest;
    const tsChannel = state.thingspeak?.channel;

    // Device telemetry fallback
    const onlineDev = state.devices.find(d => d.status === 'online') || state.devices[0];
    const devReadings = onlineDev?.currentReadings || {};

    const nodeLabel = document.getElementById('telemetryDeviceName');
    if (nodeLabel) {
        if (tsChannel) {
            nodeLabel.textContent = `ThingSpeak: ${tsChannel.name || 'Channel ' + tsChannel.id} (#${tsChannel.id})`;
        } else if (onlineDev) {
            nodeLabel.textContent = `${onlineDev.name} (${onlineDev.id})`;
        }
    }

    // 1. Soil Moisture (ThingSpeak field4)
    const m = tsLatest ? (typeof tsLatest.moisture === 'number' ? tsLatest.moisture : null)
                      : (typeof devReadings.moisture === 'number' ? devReadings.moisture : null);
    const mElem = document.getElementById('ovMoisture');
    const mCond = document.getElementById('ovMoistureCond');
    const mSrc = document.getElementById('ovMoistureSource');

    if (mSrc) {
        mSrc.textContent = tsChannel ? `ThingSpeak field4 (${tsChannel.fieldLabels?.field4 || 'Soil Moisture'})` : 'Capacitive Soil Sensor (GPIO 34)';
    }

    if (m !== null && !isNaN(m)) {
        mElem.textContent = `${m.toFixed(1)}%`;
        if (m < 25) {
            mCond.textContent = 'Severe Dry Substrate (Action Required)';
            mCond.className = 'text-xs font-semibold text-rose-400 mt-1';
        } else if (m < 40) {
            mCond.textContent = 'Dry Substrate (Warning)';
            mCond.className = 'text-xs font-semibold text-amber-400 mt-1';
        } else if (m > 80) {
            mCond.textContent = 'Saturated / Wet';
            mCond.className = 'text-xs font-semibold text-sky-400 mt-1';
        } else {
            mCond.textContent = 'Optimal Substrate Hydration';
            mCond.className = 'text-xs font-semibold text-emerald-400 mt-1';
        }
    } else {
        mElem.textContent = 'No data available';
        mCond.textContent = 'Sensor feed offline';
        mCond.className = 'text-xs font-semibold text-slate-500 mt-1';
    }

    // 2. Ambient Temperature (ThingSpeak field1)
    const t = tsLatest ? (typeof tsLatest.temperature === 'number' ? tsLatest.temperature : null)
                      : (typeof devReadings.temperature === 'number' ? devReadings.temperature : null);
    const tElem = document.getElementById('ovTemp');
    const tCond = document.getElementById('ovTempCond');
    const tSrc = document.getElementById('ovTempSource');

    if (tSrc) {
        tSrc.textContent = tsChannel ? `ThingSpeak field1 (${tsChannel.fieldLabels?.field1 || 'Environmental Temp'})` : 'Sensor: DHT22 (GPIO 4)';
    }

    if (t !== null && !isNaN(t)) {
        tElem.textContent = `${t.toFixed(1)}°C`;
        if (t < 16) {
            tCond.textContent = 'Cold Draft Risk';
            tCond.className = 'text-xs font-semibold text-sky-400 mt-1';
        } else if (t > 30) {
            tCond.textContent = 'High Heat Stress';
            tCond.className = 'text-xs font-semibold text-rose-400 mt-1';
        } else {
            tCond.textContent = 'Thermal Comfort Range';
            tCond.className = 'text-xs font-semibold text-emerald-400 mt-1';
        }
    } else {
        tElem.textContent = 'No data available';
        tCond.textContent = 'Sensor feed offline';
        tCond.className = 'text-xs font-semibold text-slate-500 mt-1';
    }

    // 3. Air Humidity (ThingSpeak field2)
    const h = tsLatest ? (typeof tsLatest.humidity === 'number' ? tsLatest.humidity : null)
                      : (typeof devReadings.humidity === 'number' ? devReadings.humidity : null);
    const hElem = document.getElementById('ovHum');
    const hCond = document.getElementById('ovHumCond');
    const hSrc = document.getElementById('ovHumSource');

    if (hSrc) {
        hSrc.textContent = tsChannel ? `ThingSpeak field2 (${tsChannel.fieldLabels?.field2 || 'Air Humidity'})` : 'Sensor: DHT22 (GPIO 4)';
    }

    if (h !== null && !isNaN(h)) {
        hElem.textContent = `${h.toFixed(1)}%`;
        if (h < 40) {
            hCond.textContent = 'Low Humidity (Mist needed)';
            hCond.className = 'text-xs font-semibold text-amber-400 mt-1';
        } else if (h > 85) {
            hCond.textContent = 'High Humidity Saturated';
            hCond.className = 'text-xs font-semibold text-sky-400 mt-1';
        } else {
            hCond.textContent = 'Optimal Transpiration';
            hCond.className = 'text-xs font-semibold text-emerald-400 mt-1';
        }
    } else {
        hElem.textContent = 'No data available';
        hCond.textContent = 'Sensor feed offline';
        hCond.className = 'text-xs font-semibold text-slate-500 mt-1';
    }

    // 4. Light Intensity (ThingSpeak field3)
    const l = tsLatest ? (typeof tsLatest.light === 'number' ? tsLatest.light : null)
                      : (typeof devReadings.light === 'number' ? devReadings.light : null);
    const lElem = document.getElementById('ovLight');
    const lCond = document.getElementById('ovLightCond');
    const lSrc = document.getElementById('ovLightSource');

    if (lSrc) {
        lSrc.textContent = tsChannel ? `ThingSpeak field3 (${tsChannel.fieldLabels?.field3 || 'Light Level'})` : 'Sensor: BH1750 (I2C)';
    }

    if (l !== null && !isNaN(l)) {
        lElem.textContent = `${l.toLocaleString()} lx`;
        if (l < 200) {
            lCond.textContent = 'Low / Dim Ambient Light';
            lCond.className = 'text-xs font-semibold text-amber-300 mt-1';
        } else if (l > 15000) {
            lCond.textContent = 'Direct Intense Sunlight';
            lCond.className = 'text-xs font-semibold text-rose-400 mt-1';
        } else {
            lCond.textContent = 'Moderate Indirect Sun';
            lCond.className = 'text-xs font-semibold text-emerald-400 mt-1';
        }
    } else {
        lElem.textContent = 'No data available';
        lCond.textContent = 'Sensor feed offline';
        lCond.className = 'text-xs font-semibold text-slate-500 mt-1';
    }

    // 5. Water Reservoir Tank Level (Local Ultrasonic HC-SR04)
    const tank = typeof devReadings.tankLevel === 'number' ? devReadings.tankLevel : 82;
    const tankElem = document.getElementById('ovTank');
    const tankCond = document.getElementById('ovTankCond');
    const tankBar = document.getElementById('ovTankBar');
    if (tankElem) {
        if (tank !== null && !isNaN(tank)) {
            tankElem.textContent = `${tank}%`;
            if (tankBar) tankBar.style.width = `${tank}%`;
            if (tank <= 15) {
                tankCond.textContent = 'CRITICAL: Reservoir Empty';
                tankCond.className = 'text-xs font-semibold text-rose-400 mt-1';
                if (tankBar) tankBar.className = 'bg-rose-500 h-full rounded-full';
            } else if (tank <= 30) {
                tankCond.textContent = 'Warning: Tank Low';
                tankCond.className = 'text-xs font-semibold text-amber-400 mt-1';
                if (tankBar) tankBar.className = 'bg-amber-500 h-full rounded-full';
            } else {
                tankCond.textContent = 'Reservoir Normal';
                tankCond.className = 'text-xs font-semibold text-emerald-400 mt-1';
                if (tankBar) tankBar.className = 'bg-sky-500 h-full rounded-full';
            }
        } else {
            tankElem.textContent = 'No data available';
            tankCond.textContent = 'Ultrasonic offline';
            tankCond.className = 'text-xs font-semibold text-slate-500 mt-1';
        }
    }
}

// ---------------------------------------------------------------------------
// PLANTS TAB & CARD RENDERING
// ---------------------------------------------------------------------------
function renderPlantsList() {
    const grid = document.getElementById('plantsGrid');
    const quickGrid = document.getElementById('overviewPlantsList');
    if (!grid) return;

    grid.innerHTML = '';
    if (quickGrid) quickGrid.innerHTML = '';

    let healthyCount = 0;
    let attentionCount = 0;

    state.plants.forEach(plant => {
        // Derive health from assigned device telemetry
        const device = state.devices.find(d => d.id === plant.assignedDeviceId);
        const telemetry = device?.currentReadings || null;

        // Health calculation
        const health = evaluatePlantHealthClient(plant, telemetry);
        if (health.score >= 70) healthyCount++;
        else attentionCount++;

        // Status badge color
        let statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">HEALTHY (EXCELLENT)</span>';
        if (health.score < 45) {
            statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/20 text-rose-400 border border-rose-500/30">CRITICAL ATTENTION</span>';
        } else if (health.score < 70) {
            statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">MODERATE STRESS</span>';
        }

        // Full Plant Card
        const card = document.createElement('div');
        card.className = 'rounded-xl bg-slate-900 border border-slate-800 overflow-hidden flex flex-col justify-between hover:border-slate-700 transition shadow-sm';
        card.innerHTML = `
            <div>
                <div class="relative h-48 w-full bg-slate-950 overflow-hidden">
                    <img src="${plant.image || '/src/assets/images/plant_monstera_deliciosa_1793943423768.jpg'}" alt="${plant.name}" class="w-full h-full object-cover">
                    <div class="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/20 to-transparent"></div>
                    <div class="absolute bottom-3 left-4 right-4 flex items-end justify-between">
                        <div>
                            <div class="text-xs text-emerald-400 font-mono font-medium">${plant.location}</div>
                            <h3 class="text-lg font-bold text-white tracking-tight">${plant.name}</h3>
                            <div class="text-xs text-slate-300 italic">${plant.species}</div>
                        </div>
                        <div class="text-right">
                            <div class="text-2xl font-bold font-mono text-emerald-400 tabular-nums">${health.score}<span class="text-xs text-slate-400">/100</span></div>
                        </div>
                    </div>
                </div>

                <div class="p-5 space-y-4">
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-slate-400">Status & Hardware:</span>
                        <div class="flex items-center gap-2">
                            ${statusBadge}
                            <span class="font-mono text-slate-400">${device ? (device.status === 'online' ? '🟢 ' + device.name : '⚪ ' + device.name) : 'No Device'}</span>
                        </div>
                    </div>

                    <!-- Environmental Readings for this plant -->
                    <div class="grid grid-cols-4 gap-2 text-center p-2.5 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                        <div>
                            <div class="text-[10px] text-slate-500">Moisture</div>
                            <div class="font-mono font-bold ${telemetry && telemetry.moisture < plant.preferredMoistureMin ? 'text-rose-400' : 'text-emerald-400'}">
                                ${telemetry && typeof telemetry.moisture === 'number' ? telemetry.moisture + '%' : '--'}
                            </div>
                        </div>
                        <div>
                            <div class="text-[10px] text-slate-500">Temp</div>
                            <div class="font-mono font-bold text-rose-400">
                                ${telemetry && typeof telemetry.temperature === 'number' ? telemetry.temperature + '°C' : '--'}
                            </div>
                        </div>
                        <div>
                            <div class="text-[10px] text-slate-500">Humidity</div>
                            <div class="font-mono font-bold text-purple-400">
                                ${telemetry && typeof telemetry.humidity === 'number' ? telemetry.humidity + '%' : '--'}
                            </div>
                        </div>
                        <div>
                            <div class="text-[10px] text-slate-500">Light</div>
                            <div class="font-mono font-bold text-amber-400">
                                ${telemetry && typeof telemetry.light === 'number' ? telemetry.light + ' lx' : '--'}
                            </div>
                        </div>
                    </div>

                    <!-- Botanical Diagnostics -->
                    <div class="p-3 bg-slate-950/80 rounded-lg border border-slate-800/80 text-xs space-y-1.5">
                        <div class="font-semibold text-slate-300 flex items-center justify-between">
                            <span>Botanical Health Assessment</span>
                            <span class="font-normal text-slate-500">${health.status}</span>
                        </div>
                        <p class="text-slate-400 text-[11px] leading-relaxed">${health.summary}</p>
                        ${health.recommendations.length > 0 ? `<div class="text-[11px] text-sky-400 pt-1 border-t border-slate-800"><strong>Recommendation:</strong> ${health.recommendations[0]}</div>` : ''}
                    </div>

                    <!-- Threshold Bounds -->
                    <div class="text-[11px] text-slate-500 space-y-1">
                        <div>Target Moisture: <strong class="text-slate-300 font-mono">${plant.preferredMoistureMin}% - ${plant.preferredMoistureMax}%</strong></div>
                        <div>Target Temperature: <strong class="text-slate-300 font-mono">${plant.preferredTempMin}°C - ${plant.preferredTempMax}°C</strong></div>
                    </div>
                </div>
            </div>

            <div class="px-5 pb-5 pt-1 border-t border-slate-800/60 flex items-center justify-between gap-2">
                <button onclick="triggerQuickWater('${plant.id}')" class="px-3 py-1.5 bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 text-xs font-semibold rounded-lg border border-emerald-500/30 transition flex items-center gap-1.5">
                    <span>💧</span>
                    <span>Water Now (8s)</span>
                </button>
                <div class="flex items-center gap-2">
                    <button onclick="openEditPlantModal('${plant.id}')" class="px-2.5 py-1.5 text-xs text-slate-400 hover:text-white border border-slate-800 rounded-lg hover:bg-slate-800 transition">
                        Edit
                    </button>
                    <button onclick="deletePlant('${plant.id}')" class="px-2.5 py-1.5 text-xs text-rose-400 hover:text-rose-300 border border-slate-800 rounded-lg hover:bg-rose-950/40 transition">
                        Delete
                    </button>
                </div>
            </div>
        `;
        grid.appendChild(card);

        // Overview Quick Grid item
        if (quickGrid) {
            const qCard = document.createElement('div');
            qCard.className = 'p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center gap-3.5 hover:border-slate-700 transition';
            qCard.innerHTML = `
                <img src="${plant.image || '/src/assets/images/plant_monstera_deliciosa_1793943423768.jpg'}" class="w-14 h-14 rounded-lg object-cover bg-slate-950 shrink-0">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between">
                        <div class="font-semibold text-white text-xs truncate">${plant.name}</div>
                        <span class="font-mono text-xs font-bold text-emerald-400">${health.score}/100</span>
                    </div>
                    <div class="text-[11px] text-slate-400 truncate">${plant.location}</div>
                    <div class="mt-1 text-[11px] text-slate-500 flex items-center gap-2">
                        <span>Moisture: <strong class="text-slate-300 font-mono">${telemetry ? telemetry.moisture + '%' : '--'}</strong></span>
                        <span>&bull;</span>
                        <span>Temp: <strong class="text-slate-300 font-mono">${telemetry ? telemetry.temperature + '°C' : '--'}</strong></span>
                    </div>
                </div>
            `;
            quickGrid.appendChild(qCard);
        }
    });

    document.getElementById('kpiHealthyPlants').textContent = healthyCount;
    document.getElementById('kpiAttentionPlants').textContent = attentionCount;
}

function evaluatePlantHealthClient(plant, telemetry) {
    if (!telemetry) {
        return { score: 65, status: 'Fair', summary: 'Waiting for device sensor packet', recommendations: ['Verify ESP32 power and Wi-Fi connection'] };
    }
    let score = 100;
    const issues = [];
    const recommendations = [];

    // Soil moisture
    if (typeof telemetry.moisture === 'number') {
        const minM = plant.preferredMoistureMin || 40;
        const maxM = plant.preferredMoistureMax || 75;
        if (telemetry.moisture < minM) {
            score -= Math.min(35, (minM - telemetry.moisture) * 1.5);
            issues.push(`Soil moisture low (${telemetry.moisture}%)`);
            recommendations.push(`Run irrigation cycle for ${plant.name}`);
        } else if (telemetry.moisture > maxM) {
            score -= Math.min(30, (telemetry.moisture - maxM) * 1.2);
            issues.push(`Substrate waterlogged (${telemetry.moisture}%)`);
            recommendations.push('Pause irrigation to prevent root rot');
        }
    }

    // Temperature
    if (typeof telemetry.temperature === 'number') {
        const minT = plant.preferredTempMin || 18;
        const maxT = plant.preferredTempMax || 28;
        if (telemetry.temperature < minT) {
            score -= Math.min(25, (minT - telemetry.temperature) * 3);
            issues.push(`Cold stress (${telemetry.temperature}°C)`);
            recommendations.push('Protect plant from cold drafts');
        } else if (telemetry.temperature > maxT) {
            score -= Math.min(25, (telemetry.temperature - maxT) * 3);
            issues.push(`Heat stress (${telemetry.temperature}°C)`);
            recommendations.push('Turn on cooling fan');
        }
    }

    score = Math.max(10, Math.min(100, Math.round(score)));
    let status = 'Excellent';
    if (score < 45) status = 'Critical';
    else if (score < 70) status = 'Fair';
    else if (score < 85) status = 'Good';

    return {
        score,
        status,
        summary: issues.length ? issues.join(' · ') : 'All environmental metrics within species target',
        recommendations
    };
}

// ---------------------------------------------------------------------------
// ACTUATORS & RELAY CONTROLS
// ---------------------------------------------------------------------------
function renderActuators() {
    const grid = document.getElementById('actuatorsGrid');
    const overviewList = document.getElementById('overviewActuatorsList');
    if (!grid) return;

    grid.innerHTML = '';
    if (overviewList) overviewList.innerHTML = '';

    state.actuators.forEach(act => {
        const isReportedOn = act.reportedState === 'ON';
        const isDesiredOn = act.desiredState === 'ON';

        // Full Actuator Card
        const card = document.createElement('div');
        card.className = 'p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4 hover:border-slate-700 transition';
        card.innerHTML = `
            <div class="flex items-center justify-between">
                <div>
                    <h3 class="text-sm font-semibold text-white">${act.name}</h3>
                    <div class="text-xs text-slate-400 font-mono">${act.pin}</div>
                </div>
                <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold ${isReportedOn ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
                    ${isReportedOn ? 'REPORTED: ON' : 'REPORTED: OFF'}
                </span>
            </div>

            <div class="flex items-center justify-between p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                <div>
                    <div class="text-[10px] text-slate-500">Mode</div>
                    <div class="font-mono text-slate-300 font-bold uppercase">${act.mode}</div>
                </div>
                <div>
                    <div class="text-[10px] text-slate-500">Commanded State</div>
                    <div class="font-mono text-slate-300 font-bold">${act.desiredState}</div>
                </div>
                <div>
                    <div class="text-[10px] text-slate-500">Hardware Pin State</div>
                    <div class="font-mono font-bold ${isReportedOn ? 'text-emerald-400' : 'text-slate-400'}">${act.reportedState}</div>
                </div>
            </div>

            <div class="flex items-center gap-2">
                <button onclick="sendActuatorCommand('${act.id}', '${isReportedOn ? 'OFF' : 'ON'}')" class="flex-1 py-2 text-xs font-semibold rounded-lg transition ${isReportedOn ? 'bg-rose-600 hover:bg-rose-500 text-white' : 'bg-emerald-600 hover:bg-emerald-500 text-white'} shadow-sm">
                    ${isReportedOn ? 'Command Relay OFF' : 'Command Relay ON'}
                </button>
                <button onclick="toggleActuatorMode('${act.id}')" class="px-3 py-2 text-xs font-mono border border-slate-800 rounded-lg text-slate-300 hover:text-white bg-slate-950 transition">
                    ${act.mode === 'auto' ? 'Set Manual' : 'Set Auto'}
                </button>
            </div>
        `;
        grid.appendChild(card);

        // Overview List Item
        if (overviewList) {
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between py-2 border-b border-slate-800/80 last:border-0 text-xs';
            item.innerHTML = `
                <div>
                    <div class="font-semibold text-white">${act.name}</div>
                    <div class="text-[10px] text-slate-400">${act.pin} &bull; Mode: ${act.mode}</div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full ${isReportedOn ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}"></span>
                    <button onclick="sendActuatorCommand('${act.id}', '${isReportedOn ? 'OFF' : 'ON'}')" class="px-2.5 py-1 rounded text-[11px] font-semibold ${isReportedOn ? 'bg-rose-600/30 text-rose-300 border border-rose-500/30' : 'bg-slate-800 text-slate-300 hover:text-white'}">
                        ${isReportedOn ? 'Turn OFF' : 'Turn ON'}
                    </button>
                </div>
            `;
            overviewList.appendChild(item);
        }
    });

    renderActuatorHistory();
}

function renderActuatorHistory() {
    const tbody = document.getElementById('actuatorHistoryBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const allHistory = [];
    state.actuators.forEach(act => {
        (act.history || []).forEach(h => {
            allHistory.push({ ...h, actuatorName: act.name });
        });
    });

    allHistory.sort((a, b) => b.timestamp - a.timestamp);
    allHistory.slice(0, 10).forEach(item => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/30';
        tr.innerHTML = `
            <td class="py-2.5 text-slate-400">${new Date(item.timestamp).toLocaleTimeString()}</td>
            <td class="py-2.5 text-white font-medium">${item.actuatorName}</td>
            <td class="py-2.5"><span class="px-1.5 py-0.5 rounded text-[10px] ${item.action === 'ON' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}">${item.action}</span></td>
            <td class="py-2.5 text-slate-400">${item.durationSeconds ? item.durationSeconds + 's' : 'Indefinite'}</td>
            <td class="py-2.5 text-slate-400">${item.triggeredBy}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function sendActuatorCommand(actuatorId, desiredState) {
    try {
        const res = await fetch('/api/v1/actuators/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actuatorId, state: desiredState })
        });
        const data = await res.json();
        if (data.success) {
            const idx = state.actuators.findIndex(a => a.id === actuatorId);
            if (idx >= 0) state.actuators[idx] = data.actuator;
            renderActuators();
        }
    } catch (err) {
        alert('Failed to send actuator command: ' + err.message);
    }
}

async function triggerQuickWater(plantId) {
    if (!confirm('Start 8-second irrigation cycle for this plant?')) return;
    await sendActuatorCommand('actuator_pump_01', 'ON');
}

async function triggerEmergencyStop() {
    if (!confirm('🛑 EMERGENCY STOP: Command all water pumps and actuators to shut off immediately?')) return;
    try {
        const res = await fetch('/api/v1/actuators/emergency-stop', { method: 'POST' });
        const data = await res.json();
        alert('Emergency shutoff dispatched. All relay lines commanded OFF.');
        state.actuators = data.actuators || state.actuators;
        renderActuators();
    } catch (err) {
        alert('Error triggering emergency stop: ' + err.message);
    }
}

async function toggleAutoWatering(checked) {
    state.settings.irrigation.autoMode = checked;
    document.getElementById('autoWateringLabel').textContent = checked ? 'AUTO ACTIVE' : 'MANUAL ONLY';
    await fetch('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ irrigation: state.settings.irrigation })
    });
}

async function saveIrrigationSettings() {
    const moistureThreshold = parseInt(document.getElementById('cfgMoistureThreshold').value, 10);
    const durationSeconds = parseInt(document.getElementById('cfgWaterDuration').value, 10);
    const cooldownMinutes = parseInt(document.getElementById('cfgCooldown').value, 10);
    const minTankLevel = parseInt(document.getElementById('cfgMinTank').value, 10);

    state.settings.irrigation = {
        ...state.settings.irrigation,
        moistureThreshold,
        durationSeconds,
        cooldownMinutes,
        minTankLevel
    };

    await fetch('/api/v1/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ irrigation: state.settings.irrigation })
    });
    alert('Irrigation automation policy updated successfully!');
}

// ---------------------------------------------------------------------------
// DEVICES (ESP32 MANAGEMENT)
// ---------------------------------------------------------------------------
function renderDevices() {
    const list = document.getElementById('devicesList');
    const logsBody = document.getElementById('deviceLogsBody');
    if (!list) return;

    list.innerHTML = '';
    state.devices.forEach(dev => {
        const isOnline = dev.status === 'online';
        const card = document.createElement('div');
        card.className = 'p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4 hover:border-slate-700 transition';
        card.innerHTML = `
            <div class="flex items-start justify-between gap-3">
                <div>
                    <div class="flex items-center gap-2">
                        <span class="w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
                        <h3 class="text-base font-bold text-white tracking-tight">${dev.name}</h3>
                    </div>
                    <div class="text-xs text-slate-400 font-mono mt-0.5">ID: ${dev.id} &bull; ${dev.location}</div>
                </div>
                <span class="px-2.5 py-1 rounded text-xs font-mono font-semibold ${isOnline ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
                    ${isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
            </div>

            <!-- Wi-Fi & Network Stats -->
            <div class="grid grid-cols-3 gap-2.5 p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs">
                <div>
                    <div class="text-[10px] text-slate-500">Wi-Fi Signal</div>
                    <div class="font-mono text-slate-300">${dev.wifiRssi ? dev.wifiRssi + ' dBm' : '--'}</div>
                </div>
                <div>
                    <div class="text-[10px] text-slate-500">IP Address</div>
                    <div class="font-mono text-slate-300">${dev.ipAddress || '--'}</div>
                </div>
                <div>
                    <div class="text-[10px] text-slate-500">Last Seen</div>
                    <div class="font-mono text-slate-300">${dev.lastSeen ? Math.round((Date.now() - dev.lastSeen) / 1000) + 's ago' : 'Never'}</div>
                </div>
            </div>

            <!-- Device Auth Token for Firmware -->
            <div class="space-y-1">
                <div class="text-[11px] text-slate-400">Device Security Token:</div>
                <div class="flex gap-2">
                    <input type="text" readonly value="${dev.deviceToken || 'tok_esp32_sample'}" class="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs font-mono text-slate-300">
                    <button onclick="navigator.clipboard.writeText('${dev.deviceToken}'); alert('Token copied!');" class="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs">Copy</button>
                </div>
            </div>

            <!-- Connected Sensors -->
            <div class="space-y-1.5 pt-1">
                <div class="text-[11px] text-slate-400 font-medium">Configured Sensors:</div>
                <div class="flex flex-wrap gap-1.5">
                    ${(dev.supportedSensors || []).map(s => `
                        <span class="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300">
                            ${s.name} (${s.pin})
                        </span>
                    `).join('')}
                </div>
            </div>

            <div class="flex justify-end pt-2 border-t border-slate-800/80">
                <button onclick="deleteDevice('${dev.id}')" class="px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 border border-slate-800 hover:border-rose-900 rounded-lg transition">
                    Remove Device
                </button>
            </div>
        `;
        list.appendChild(card);
    });

    // Populate Diagnostic Logs
    if (logsBody) {
        logsBody.innerHTML = '';
        state.devices.forEach(dev => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="py-2 text-slate-400">${new Date().toLocaleTimeString()}</td>
                <td class="py-2 text-white">${dev.id}</td>
                <td class="py-2 text-emerald-400">HTTP/WebSocket</td>
                <td class="py-2">${dev.wifiRssi ? dev.wifiRssi + ' dBm' : 'N/A'}</td>
                <td class="py-2"><span class="px-1.5 py-0.5 rounded text-[10px] ${dev.status === 'online' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}">${dev.status.toUpperCase()}</span></td>
            `;
            logsBody.appendChild(tr);
        });
    }
}

// ---------------------------------------------------------------------------
// SENSOR HARDWARE VERIFICATION LIST
// ---------------------------------------------------------------------------
function renderSensorList() {
    const list = document.getElementById('hardwareSensorList');
    if (!list) return;

    const onlineDev = state.devices.find(d => d.status === 'online');
    const sensors = [
        { name: 'Capacitive Moisture Sensor', pin: 'GPIO 34', active: Boolean(onlineDev?.currentReadings?.moisture !== undefined) },
        { name: 'DHT22 Temperature', pin: 'GPIO 4', active: Boolean(onlineDev?.currentReadings?.temperature !== undefined) },
        { name: 'DHT22 Air Humidity', pin: 'GPIO 4', active: Boolean(onlineDev?.currentReadings?.humidity !== undefined) },
        { name: 'BH1750 Ambient Light', pin: 'GPIO 21/22', active: Boolean(onlineDev?.currentReadings?.light !== undefined) },
        { name: 'HC-SR04 Water Depth', pin: 'GPIO 12/14', active: Boolean(onlineDev?.currentReadings?.tankLevel !== undefined) }
    ];

    list.innerHTML = sensors.map(s => `
        <div class="flex items-center justify-between p-2.5 rounded-lg bg-slate-950 border border-slate-800">
            <div>
                <div class="font-medium text-white">${s.name}</div>
                <div class="text-[10px] text-slate-500 font-mono">${s.pin}</div>
            </div>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono ${s.active ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-500'}">
                ${s.active ? 'CONNECTED' : 'WAITING DATA'}
            </span>
        </div>
    `).join('');
}

// ---------------------------------------------------------------------------
// ALERTS FEED
// ---------------------------------------------------------------------------
function renderAlerts() {
    const feed = document.getElementById('alertsFeedList');
    const ticker = document.getElementById('quickAlertTicker');
    const badge = document.getElementById('navAlertBadge');
    if (!feed) return;

    feed.innerHTML = '';
    const filtered = state.alerts.filter(a => {
        if (state.alertFilter === 'all') return true;
        return a.severity === state.alertFilter;
    });

    const unreadCount = state.alerts.filter(a => !a.read).length;
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    if (ticker) {
        if (state.alerts.length > 0) {
            const first = state.alerts[0];
            ticker.innerHTML = `<span class="w-2 h-2 rounded-full ${first.severity === 'critical' ? 'bg-rose-400 animate-pulse' : 'bg-amber-400'}"></span><span>${first.title}: ${first.message.substring(0, 45)}...</span>`;
        } else {
            ticker.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400"></span><span>All systems nominal</span>';
        }
    }

    if (filtered.length === 0) {
        feed.innerHTML = '<div class="p-8 text-center text-xs text-slate-500">No active alerts for current filter.</div>';
        return;
    }

    filtered.forEach(alert => {
        let borderClass = 'border-slate-800';
        let badgeClass = 'bg-sky-500/10 text-sky-400 border-sky-500/30';
        if (alert.severity === 'critical') {
            borderClass = 'border-rose-900/40 bg-rose-950/20';
            badgeClass = 'bg-rose-500/20 text-rose-400 border-rose-500/40';
        } else if (alert.severity === 'warning') {
            borderClass = 'border-amber-900/40 bg-amber-950/20';
            badgeClass = 'bg-amber-500/20 text-amber-400 border-amber-500/40';
        }

        const div = document.createElement('div');
        div.className = `p-4 rounded-xl border ${borderClass} flex items-start justify-between gap-4 transition`;
        div.innerHTML = `
            <div class="space-y-1">
                <div class="flex items-center gap-2">
                    <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${badgeClass}">${alert.severity}</span>
                    <h4 class="text-xs font-bold text-white">${alert.title}</h4>
                    <span class="text-[10px] text-slate-500 font-mono">${new Date(alert.timestamp).toLocaleTimeString()}</span>
                </div>
                <p class="text-xs text-slate-300 leading-relaxed">${alert.message}</p>
            </div>
            <button onclick="markAlertRead('${alert.id}')" class="px-2.5 py-1 text-xs text-slate-400 hover:text-white border border-slate-800 hover:bg-slate-800 rounded transition shrink-0">
                Dismiss
            </button>
        `;
        feed.appendChild(div);
    });
}

function filterAlerts(filter) {
    state.alertFilter = filter;
    document.querySelectorAll('.alert-filter-btn').forEach(btn => {
        if (btn.getAttribute('data-alertfilter') === filter) {
            btn.classList.add('bg-slate-800', 'text-white');
        } else {
            btn.classList.remove('bg-slate-800', 'text-white');
        }
    });
    renderAlerts();
}

async function markAlertRead(alertId) {
    await fetch(`/api/v1/alerts/${alertId}/read`, { method: 'PATCH' });
    const al = state.alerts.find(a => a.id === alertId);
    if (al) al.read = true;
    renderAlerts();
}

async function clearAllAlerts() {
    await fetch('/api/v1/alerts/clear', { method: 'POST' });
    state.alerts = [];
    renderAlerts();
}

// ---------------------------------------------------------------------------
// CHARTS INITIALIZATION (LIVE & ANALYTICS)
// ---------------------------------------------------------------------------
function initCharts() {
    // 1. Live Moisture Chart
    const lmcCtx = document.getElementById('liveMoistureChart')?.getContext('2d');
    if (lmcCtx) {
        liveMoistureChart = new Chart(lmcCtx, {
            type: 'line',
            data: {
                labels: Array.from({ length: 30 }, (_, i) => `-${30 - i}m`),
                datasets: [{
                    label: 'Soil Moisture (%)',
                    data: state.latestTelemetry.slice(-30).map(t => t.moisture),
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.15)',
                    tension: 0.35,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { min: 0, max: 100, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });
    }

    // 2. Live Temp vs Humidity Chart
    const lthCtx = document.getElementById('liveTempHumChart')?.getContext('2d');
    if (lthCtx) {
        liveTempHumChart = new Chart(lthCtx, {
            type: 'line',
            data: {
                labels: Array.from({ length: 30 }, (_, i) => `-${30 - i}m`),
                datasets: [
                    {
                        label: 'Temperature (°C)',
                        data: state.latestTelemetry.slice(-30).map(t => t.temperature),
                        borderColor: '#f87171',
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: 2,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Humidity (%)',
                        data: state.latestTelemetry.slice(-30).map(t => t.humidity),
                        borderColor: '#c084fc',
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: 2,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { min: 10, max: 40, position: 'left', ticks: { color: '#f87171' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y1: { min: 20, max: 100, position: 'right', ticks: { color: '#c084fc' }, grid: { display: false } },
                    x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { display: false } }
                },
                plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } }
            }
        });
    }

    // 3. Analytics Charts
    initAnalyticsCharts();
}

function initAnalyticsCharts() {
    const data = state.latestTelemetry;
    const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    const amcCtx = document.getElementById('analyticsMoistureChart')?.getContext('2d');
    if (amcCtx) {
        analyticsMoistureChart = new Chart(amcCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Moisture (%)',
                    data: data.map(d => d.moisture),
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    tension: 0.3,
                    fill: true,
                    borderWidth: 2
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100, ticks: { color: '#94a3b8' } }, x: { ticks: { color: '#64748b' } } }, plugins: { legend: { display: false } } }
        });
    }

    const athCtx = document.getElementById('analyticsTempHumChart')?.getContext('2d');
    if (athCtx) {
        analyticsTempHumChart = new Chart(athCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Temp (°C)', data: data.map(d => d.temperature), borderColor: '#f87171', borderWidth: 2 },
                    { label: 'Humidity (%)', data: data.map(d => d.humidity), borderColor: '#a855f7', borderWidth: 2 }
                ]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { color: '#94a3b8' } }, x: { ticks: { color: '#64748b' } } }, plugins: { legend: { labels: { color: '#cbd5e1' } } } }
        });
    }

    const alcCtx = document.getElementById('analyticsLightChart')?.getContext('2d');
    if (alcCtx) {
        analyticsLightChart = new Chart(alcCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{ label: 'Light (Lux)', data: data.map(d => d.light), borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.15)', fill: true, tension: 0.3 }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { color: '#94a3b8' } }, x: { ticks: { color: '#64748b' } } }, plugins: { legend: { display: false } } }
        });
    }

    const atcCtx = document.getElementById('analyticsTankChart')?.getContext('2d');
    if (atcCtx) {
        analyticsTankChart = new Chart(atcCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [{ label: 'Tank Level (%)', data: data.map(d => d.tankLevel), borderColor: '#38bdf8', borderWidth: 2, fill: true, backgroundColor: 'rgba(56, 189, 248, 0.1)' }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100, ticks: { color: '#94a3b8' } }, x: { ticks: { color: '#64748b' } } }, plugins: { legend: { display: false } } }
        });
    }
}

function updateLiveCharts(record) {
    if (liveMoistureChart && typeof record.moisture === 'number') {
        const d = liveMoistureChart.data.datasets[0].data;
        const l = liveMoistureChart.data.labels;
        d.push(record.moisture);
        l.push(new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        if (d.length > 30) { d.shift(); l.shift(); }
        liveMoistureChart.update();
        document.getElementById('liveMoistureBadge').textContent = `${record.moisture}%`;
    }

    if (liveTempHumChart && typeof record.temperature === 'number' && typeof record.humidity === 'number') {
        const td = liveTempHumChart.data.datasets[0].data;
        const hd = liveTempHumChart.data.datasets[1].data;
        const l = liveTempHumChart.data.labels;
        td.push(record.temperature);
        hd.push(record.humidity);
        l.push(new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        if (td.length > 30) { td.shift(); hd.shift(); l.shift(); }
        liveTempHumChart.update();
        document.getElementById('liveTempHumBadge').textContent = `${record.temperature}°C / ${record.humidity}%`;
    }

    // Update raw ADC in calibration tool
    if (typeof record.rawMoistureAdc === 'number') {
        document.getElementById('calCurrentAdc').textContent = record.rawMoistureAdc;
    }
}

async function changeAnalyticsRange(range) {
    state.analyticsRange = range;
    document.querySelectorAll('.range-btn').forEach(btn => {
        if (btn.getAttribute('data-range') === range) {
            btn.classList.add('bg-slate-800', 'text-white');
            btn.classList.remove('text-slate-400');
        } else {
            btn.classList.remove('bg-slate-800', 'text-white');
            btn.classList.add('text-slate-400');
        }
    });

    const res = await fetch(`/api/v1/telemetry/history?range=${range}&limit=100`);
    const data = await res.json();
    const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    if (analyticsMoistureChart) {
        analyticsMoistureChart.data.labels = labels;
        analyticsMoistureChart.data.datasets[0].data = data.map(d => d.moisture);
        analyticsMoistureChart.update();
    }
    if (analyticsTempHumChart) {
        analyticsTempHumChart.data.labels = labels;
        analyticsTempHumChart.data.datasets[0].data = data.map(d => d.temperature);
        analyticsTempHumChart.data.datasets[1].data = data.map(d => d.humidity);
        analyticsTempHumChart.update();
    }
}

// ---------------------------------------------------------------------------
// SENSOR CALIBRATION WIDGET
// ---------------------------------------------------------------------------
async function setCalibrationPoint(pointType) {
    const rawVal = parseInt(document.getElementById('calCurrentAdc').textContent, 10);
    const onlineDev = state.devices.find(d => d.status === 'online') || state.devices[0];
    if (!onlineDev) return alert('No device online to calibrate');

    const cal = onlineDev.calibration || { dryAdc: 3200, wetAdc: 1400 };
    if (pointType === 'dry') {
        cal.dryAdc = rawVal;
        document.getElementById('calDryAdc').textContent = rawVal;
    } else {
        cal.wetAdc = rawVal;
        document.getElementById('calWetAdc').textContent = rawVal;
    }

    await fetch(`/api/v1/devices/${onlineDev.id}/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cal)
    });
    alert(`Successfully stored ${pointType.toUpperCase()} baseline ADC value: ${rawVal}`);
}

async function resetCalibration() {
    const onlineDev = state.devices.find(d => d.status === 'online') || state.devices[0];
    if (!onlineDev) return;
    await fetch(`/api/v1/devices/${onlineDev.id}/calibration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryAdc: 3200, wetAdc: 1400 })
    });
    document.getElementById('calDryAdc').textContent = '3200';
    document.getElementById('calWetAdc').textContent = '1400';
    alert('Calibrations reset to factory standard (Dry: 3200, Wet: 1400).');
}

// ---------------------------------------------------------------------------
// HARDWARE SETUP & FIRMWARE CODE VIEWER
// ---------------------------------------------------------------------------
function showFirmware(type) {
    const pre = document.getElementById('firmwareCode');
    const httpBtn = document.getElementById('fwHttpBtn');
    const mqttBtn = document.getElementById('fwMqttBtn');

    if (type === 'http') {
        pre.textContent = FIRMWARE_HTTP;
        httpBtn.className = 'px-3 py-1.5 text-xs font-mono font-medium rounded-md bg-emerald-600 text-white';
        mqttBtn.className = 'px-3 py-1.5 text-xs font-mono font-medium rounded-md bg-slate-800 text-slate-400 hover:text-white';
    } else {
        pre.textContent = FIRMWARE_MQTT;
        mqttBtn.className = 'px-3 py-1.5 text-xs font-mono font-medium rounded-md bg-emerald-600 text-white';
        httpBtn.className = 'px-3 py-1.5 text-xs font-mono font-medium rounded-md bg-slate-800 text-slate-400 hover:text-white';
    }
}

function copyFirmware() {
    const code = document.getElementById('firmwareCode').textContent;
    navigator.clipboard.writeText(code).then(() => {
        alert('ESP32 Arduino C++ firmware sketch copied to clipboard!');
    });
}

// ---------------------------------------------------------------------------
// MODALS & CRUD (PLANTS & DEVICES)
// ---------------------------------------------------------------------------
function openAddPlantModal() {
    document.getElementById('plantModalTitle').textContent = 'Add Plant Profile';
    document.getElementById('pfId').value = '';
    document.getElementById('pfName').value = '';
    document.getElementById('pfSpecies').value = '';
    document.getElementById('pfLocation').value = '';

    // Populate devices dropdown
    const devSelect = document.getElementById('pfDevice');
    devSelect.innerHTML = '<option value="">None (Unassigned)</option>' +
        state.devices.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('');

    document.getElementById('plantModal').classList.remove('hidden');
}

function openEditPlantModal(plantId) {
    const plant = state.plants.find(p => p.id === plantId);
    if (!plant) return;

    document.getElementById('plantModalTitle').textContent = 'Edit Plant Profile';
    document.getElementById('pfId').value = plant.id;
    document.getElementById('pfName').value = plant.name;
    document.getElementById('pfSpecies').value = plant.species;
    document.getElementById('pfLocation').value = plant.location;
    document.getElementById('pfMoistureMin').value = plant.preferredMoistureMin || 40;
    document.getElementById('pfMoistureMax').value = plant.preferredMoistureMax || 75;
    document.getElementById('pfTempMin').value = plant.preferredTempMin || 18;
    document.getElementById('pfTempMax').value = plant.preferredTempMax || 28;

    const devSelect = document.getElementById('pfDevice');
    devSelect.innerHTML = '<option value="">None (Unassigned)</option>' +
        state.devices.map(d => `<option value="${d.id}" ${d.id === plant.assignedDeviceId ? 'selected' : ''}>${d.name} (${d.id})</option>`).join('');

    document.getElementById('plantModal').classList.remove('hidden');
}

function closePlantModal() {
    document.getElementById('plantModal').classList.add('hidden');
}

async function handleSavePlant(e) {
    e.preventDefault();
    const id = document.getElementById('pfId').value;
    const plantData = {
        id: id || undefined,
        name: document.getElementById('pfName').value,
        species: document.getElementById('pfSpecies').value,
        location: document.getElementById('pfLocation').value,
        assignedDeviceId: document.getElementById('pfDevice').value || null,
        preferredMoistureMin: parseInt(document.getElementById('pfMoistureMin').value, 10),
        preferredMoistureMax: parseInt(document.getElementById('pfMoistureMax').value, 10),
        preferredTempMin: parseInt(document.getElementById('pfTempMin').value, 10),
        preferredTempMax: parseInt(document.getElementById('pfTempMax').value, 10)
    };

    const res = await fetch('/api/v1/plants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plantData)
    });
    const saved = await res.json();

    const idx = state.plants.findIndex(p => p.id === saved.id);
    if (idx >= 0) state.plants[idx] = saved;
    else state.plants.push(saved);

    closePlantModal();
    renderPlantsList();
    renderOverviewKPIs();
}

async function deletePlant(plantId) {
    if (!confirm('Are you sure you want to delete this plant profile?')) return;
    await fetch(`/api/v1/plants/${plantId}`, { method: 'DELETE' });
    state.plants = state.plants.filter(p => p.id !== plantId);
    renderPlantsList();
    renderOverviewKPIs();
}

function openRegisterDeviceModal() {
    document.getElementById('dfId').value = `esp32_node_${Math.floor(Math.random() * 899 + 100)}`;
    document.getElementById('dfName').value = 'Greenhouse Microcontroller';
    document.getElementById('dfLocation').value = 'Plant Station';
    generateDeviceToken();
    document.getElementById('deviceModal').classList.remove('hidden');
}

function closeDeviceModal() {
    document.getElementById('deviceModal').classList.add('hidden');
}

function generateDeviceToken() {
    document.getElementById('dfToken').value = `tok_esp32_${Math.random().toString(36).substring(2, 10)}`;
}

async function handleRegisterDevice(e) {
    e.preventDefault();
    const devData = {
        id: document.getElementById('dfId').value.trim(),
        name: document.getElementById('dfName').value.trim(),
        location: document.getElementById('dfLocation').value.trim(),
        deviceToken: document.getElementById('dfToken').value
    };

    const res = await fetch('/api/v1/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(devData)
    });
    const saved = await res.json();

    state.devices.push(saved);
    closeDeviceModal();
    renderDevices();
    renderOverviewKPIs();
    alert(`ESP32 '${saved.name}' registered! Use token '${saved.deviceToken}' in your firmware.`);
}

async function deleteDevice(deviceId) {
    if (!confirm(`Remove ESP32 hardware device '${deviceId}'?`)) return;
    await fetch(`/api/v1/devices/${deviceId}`, { method: 'DELETE' });
    state.devices = state.devices.filter(d => d.id !== deviceId);
    renderDevices();
    renderOverviewKPIs();
}

async function toggleSimMode(checked) {
    await fetch('/api/v1/simulation/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked })
    });
    state.settings.demoMode = checked;
    updateSimulationBadge();
}

// ---------------------------------------------------------------------------
// THINGSPEAK IOT CLOUD INTEGRATION & CONNECT DEVICE
// ---------------------------------------------------------------------------

let tsCountdownInterval = null;

async function fetchThingSpeakLatest() {
    try {
        const res = await fetch('/api/v1/thingspeak/data');
        const data = await res.json();
        if (data.success && data.channel) {
            state.thingspeak.channel = data.channel;
            state.thingspeak.latest = data.latest;
            state.thingspeak.feeds = data.feeds || [];
            state.thingspeak.status = data.status || { status: 'Connected', label: 'Connected' };
            state.thingspeak.countdown = 20;

            renderThingSpeakUI();
            renderOverviewGauges();
            if (data.feeds && data.feeds.length > 0) {
                updateChartsFromThingSpeakFeeds(data.feeds);
            }
        } else if (data.status) {
            state.thingspeak.status = data.status;
            renderThingSpeakUI();
        }
    } catch (err) {
        console.warn('ThingSpeak poll error:', err.message);
        state.thingspeak.status = {
            status: 'Error',
            label: 'Error',
            reason: 'Network error communicating with ThingSpeak proxy: ' + err.message,
            isRecent: false
        };
        renderThingSpeakUI();
    }
}

function startThingSpeakPolling() {
    if (tsCountdownInterval) clearInterval(tsCountdownInterval);
    state.thingspeak.countdown = 20;
    const cdElem = document.getElementById('tsCountdown');
    if (cdElem) cdElem.textContent = '20';

    tsCountdownInterval = setInterval(() => {
        if (state.thingspeak.countdown > 1) {
            state.thingspeak.countdown -= 1;
            const el = document.getElementById('tsCountdown');
            if (el) el.textContent = state.thingspeak.countdown;
        } else {
            state.thingspeak.countdown = 20;
            const el = document.getElementById('tsCountdown');
            if (el) el.textContent = '20';
            fetchThingSpeakLatest();
        }
    }, 1000);
}

async function manualRefreshThingSpeak() {
    const btn = document.getElementById('tsBtnRefresh');
    const spinner = document.getElementById('tsRefreshSpinner');
    const icon = document.getElementById('tsRefreshIcon');
    if (spinner) spinner.classList.remove('hidden');
    if (icon) icon.classList.add('hidden');
    if (btn) btn.disabled = true;

    try {
        const res = await fetch('/api/v1/thingspeak/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.data) {
            state.thingspeak.channel = data.data.channel;
            state.thingspeak.latest = data.data.latest;
            state.thingspeak.feeds = data.data.feeds || [];
            state.thingspeak.status = data.data.status;
            state.thingspeak.countdown = 20;

            renderThingSpeakUI();
            renderOverviewGauges();
            if (data.data.feeds && data.data.feeds.length > 0) {
                updateChartsFromThingSpeakFeeds(data.data.feeds);
            }
        }
    } catch (e) {
        console.error('Manual ThingSpeak refresh failed:', e);
    } finally {
        if (spinner) spinner.classList.add('hidden');
        if (icon) icon.classList.remove('hidden');
        if (btn) btn.disabled = false;
    }
}

function renderThingSpeakUI() {
    const channel = state.thingspeak.channel;
    const latest = state.thingspeak.latest;
    const status = state.thingspeak.status || { status: 'Offline', label: 'Offline', reason: '' };
    const feeds = state.thingspeak.feeds || [];

    // 1. Header Status Badge
    const headerDot = document.getElementById('tsBadgeDot');
    const headerText = document.getElementById('tsBadgeText');
    const headerBadge = document.getElementById('thingSpeakStatusBadge');
    if (headerText && headerDot && headerBadge) {
        const chId = channel?.id || '1729295';
        if (status.status === 'Connected') {
            headerDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
            headerBadge.className = 'hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
            headerText.textContent = `TS #${chId}: Connected`;
        } else if (status.status === 'Stale') {
            headerDot.className = 'w-2 h-2 rounded-full bg-amber-400';
            headerBadge.className = 'hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-amber-500/10 border-amber-500/30 text-amber-300';
            headerText.textContent = `TS #${chId}: Stale`;
        } else if (status.status === 'Offline') {
            headerDot.className = 'w-2 h-2 rounded-full bg-slate-400';
            headerBadge.className = 'hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-slate-800 border-slate-700 text-slate-300';
            headerText.textContent = `TS #${chId}: Offline`;
        } else {
            headerDot.className = 'w-2 h-2 rounded-full bg-rose-400';
            headerBadge.className = 'hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border bg-rose-500/10 border-rose-500/30 text-rose-300';
            headerText.textContent = `TS #${chId}: Error`;
        }
    }

    // 2. Overview Banner
    if (channel) {
        const nameEl = document.getElementById('tsChannelName');
        const idEl = document.getElementById('tsChannelId');
        const descEl = document.getElementById('tsChannelDesc');
        if (nameEl) nameEl.textContent = channel.name || 'Unnamed Channel';
        if (idEl) idEl.textContent = channel.id || '1729295';
        if (descEl && channel.description) descEl.textContent = channel.description;
    }

    // Status Pill in Overview
    const pill = document.getElementById('tsStatusPill');
    const pillDot = document.getElementById('tsStatusDot');
    const pillLabel = document.getElementById('tsStatusLabel');
    if (pill && pillDot && pillLabel) {
        pillLabel.textContent = status.label || status.status;
        if (status.status === 'Connected') {
            pill.className = 'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border bg-emerald-500/10 border-emerald-500/30 text-emerald-300';
            pillDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
        } else if (status.status === 'Stale') {
            pill.className = 'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border bg-amber-500/10 border-amber-500/30 text-amber-300';
            pillDot.className = 'w-2 h-2 rounded-full bg-amber-400';
        } else if (status.status === 'Offline') {
            pill.className = 'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border bg-slate-800 border-slate-700 text-slate-300';
            pillDot.className = 'w-2 h-2 rounded-full bg-slate-400';
        } else {
            pill.className = 'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border bg-rose-500/10 border-rose-500/30 text-rose-300';
            pillDot.className = 'w-2 h-2 rounded-full bg-rose-400';
        }
    }

    // Timestamp & Age in Overview
    const timeEl = document.getElementById('tsLatestTimestamp');
    const ageEl = document.getElementById('tsLatestTimeAge');
    const reasonEl = document.getElementById('tsReasonText');
    if (timeEl) {
        if (latest && latest.createdAt) {
            const d = new Date(latest.createdAt);
            timeEl.textContent = d.toUTCString();
            if (ageEl) {
                const diffMs = Date.now() - d.getTime();
                const diffSec = Math.round(diffMs / 1000);
                if (diffSec < 120) {
                    ageEl.textContent = `(${diffSec}s ago)`;
                } else if (diffSec < 7200) {
                    ageEl.textContent = `(${Math.round(diffSec / 60)}m ago)`;
                } else if (diffSec < 86400 * 2) {
                    ageEl.textContent = `(${Math.round(diffSec / 3600)}h ago)`;
                } else {
                    ageEl.textContent = `(~${Math.round(diffSec / 86400)}d ago)`;
                }
            }
        } else {
            timeEl.textContent = 'No data available';
            if (ageEl) ageEl.textContent = '';
        }
    }
    if (reasonEl) {
        reasonEl.textContent = status.reason || '';
        reasonEl.title = status.reason || '';
    }

    // Overview 4 Quick Metric Chips
    const chipTemp = document.getElementById('tsChipTemp');
    const chipHum = document.getElementById('tsChipHum');
    const chipLight = document.getElementById('tsChipLight');
    const chipMoisture = document.getElementById('tsChipMoisture');

    if (chipTemp) {
        chipTemp.textContent = latest && typeof latest.temperature === 'number' ? `${latest.temperature.toFixed(1)}°C` : 'No data available';
    }
    if (chipHum) {
        chipHum.textContent = latest && typeof latest.humidity === 'number' ? `${latest.humidity.toFixed(1)}%` : 'No data available';
    }
    if (chipLight) {
        chipLight.textContent = latest && typeof latest.light === 'number' ? `${latest.light.toLocaleString()} lx` : 'No data available';
    }
    if (chipMoisture) {
        chipMoisture.textContent = latest && typeof latest.moisture === 'number' ? `${latest.moisture.toFixed(1)}%` : 'No data available';
    }

    // 3. Tab 4: Devices Card
    const devBadge = document.getElementById('tsDeviceStatusBadge');
    const devChId = document.getElementById('tsDevChannelId');
    const devChName = document.getElementById('tsDevChannelName');
    const devLastTime = document.getElementById('tsDevLastTime');
    const devTimeAgo = document.getElementById('tsDevTimeAgo');
    const devFeedCount = document.getElementById('tsDevFeedCount');
    const devHwState = document.getElementById('tsDevHardwareState');
    const devReason = document.getElementById('tsDevReasonSnippet');

    if (devBadge) {
        devBadge.textContent = status.status.toUpperCase();
        if (status.status === 'Connected') {
            devBadge.className = 'px-2 py-0.5 rounded text-[10px] font-semibold font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        } else if (status.status === 'Stale') {
            devBadge.className = 'px-2 py-0.5 rounded text-[10px] font-semibold font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30';
        } else if (status.status === 'Offline') {
            devBadge.className = 'px-2 py-0.5 rounded text-[10px] font-semibold font-mono bg-slate-800 text-slate-300 border border-slate-700';
        } else {
            devBadge.className = 'px-2 py-0.5 rounded text-[10px] font-semibold font-mono bg-rose-500/20 text-rose-300 border border-rose-500/30';
        }
    }
    if (devChId && channel) devChId.textContent = channel.id || '1729295';
    if (devChName && channel) devChName.textContent = channel.name || 'Smart Agriculture';
    if (devLastTime) {
        devLastTime.textContent = latest?.createdAt ? new Date(latest.createdAt).toUTCString() : 'No feeds recorded';
    }
    if (devTimeAgo) {
        devTimeAgo.textContent = latest?.entryId ? `Entry #${latest.entryId} recorded` : 'No hardware entry';
    }
    if (devFeedCount) {
        devFeedCount.textContent = `${feeds.length} Feeds in Memory`;
    }
    if (devHwState) {
        devHwState.textContent = status.label;
        devHwState.className = `text-xs font-bold mt-0.5 block ${status.status === 'Connected' ? 'text-emerald-400' : (status.status === 'Stale' ? 'text-amber-400' : (status.status === 'Offline' ? 'text-slate-400' : 'text-rose-400'))}`;
    }
    if (devReason) {
        devReason.textContent = status.reason || '';
        devReason.title = status.reason || '';
    }

    // Devices Table Rows
    const rowTemp = document.getElementById('tsTableRowTemp');
    const rowHum = document.getElementById('tsTableRowHum');
    const rowLight = document.getElementById('tsTableRowLight');
    const rowMoisture = document.getElementById('tsTableRowMoisture');

    if (rowTemp) rowTemp.textContent = latest && typeof latest.temperature === 'number' ? `${latest.temperature.toFixed(1)}°C` : 'No data available';
    if (rowHum) rowHum.textContent = latest && typeof latest.humidity === 'number' ? `${latest.humidity.toFixed(1)}%` : 'No data available';
    if (rowLight) rowLight.textContent = latest && typeof latest.light === 'number' ? `${latest.light.toLocaleString()} lx` : 'No data available';
    if (rowMoisture) rowMoisture.textContent = latest && typeof latest.moisture === 'number' ? `${latest.moisture.toFixed(1)}%` : 'No data available';
}

function updateChartsFromThingSpeakFeeds(feeds) {
    if (!Array.isArray(feeds) || feeds.length === 0) return;

    const labels = feeds.map(f => {
        if (!f.createdAt) return '';
        const d = new Date(f.createdAt);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });

    if (liveMoistureChart) {
        liveMoistureChart.data.labels = labels;
        liveMoistureChart.data.datasets[0].data = feeds.map(f => f.moisture);
        liveMoistureChart.update();
        const lastM = feeds[feeds.length - 1].moisture;
        const b = document.getElementById('liveMoistureBadge');
        if (b) b.textContent = lastM !== null ? `${lastM.toFixed(1)}%` : 'No data available';
    }

    if (liveTempHumChart) {
        liveTempHumChart.data.labels = labels;
        liveTempHumChart.data.datasets[0].data = feeds.map(f => f.temperature);
        liveTempHumChart.data.datasets[1].data = feeds.map(f => f.humidity);
        liveTempHumChart.update();
        const lastT = feeds[feeds.length - 1].temperature;
        const lastH = feeds[feeds.length - 1].humidity;
        const b = document.getElementById('liveTempHumBadge');
        if (b) {
            const tText = lastT !== null ? `${lastT.toFixed(1)}°C` : 'No data';
            const hText = lastH !== null ? `${lastH.toFixed(1)}%` : 'No data';
            b.textContent = `${tText} / ${hText}`;
        }
    }

    if (analyticsMoistureChart) {
        analyticsMoistureChart.data.labels = labels;
        analyticsMoistureChart.data.datasets[0].data = feeds.map(f => f.moisture);
        analyticsMoistureChart.update();
    }

    if (analyticsTempHumChart) {
        analyticsTempHumChart.data.labels = labels;
        analyticsTempHumChart.data.datasets[0].data = feeds.map(f => f.temperature);
        analyticsTempHumChart.data.datasets[1].data = feeds.map(f => f.humidity);
        analyticsTempHumChart.update();
    }

    if (analyticsLightChart) {
        analyticsLightChart.data.labels = labels;
        analyticsLightChart.data.datasets[0].data = feeds.map(f => f.light);
        analyticsLightChart.update();
    }
}

function openConnectDeviceModal() {
    const tsSettings = state.settings?.thingspeak || {};
    const chIdInput = document.getElementById('tsFormChannelId');
    const apiKeyInput = document.getElementById('tsFormApiKey');
    const resultsInput = document.getElementById('tsFormResults');

    if (chIdInput) chIdInput.value = tsSettings.channelId || '1729295';
    if (apiKeyInput) apiKeyInput.value = tsSettings.readApiKey || '';
    if (resultsInput) resultsInput.value = tsSettings.results || 20;

    const banner = document.getElementById('tsModalTestBanner');
    if (banner) banner.classList.add('hidden');

    document.getElementById('connectDeviceModal').classList.remove('hidden');
}

function closeConnectDeviceModal() {
    document.getElementById('connectDeviceModal').classList.add('hidden');
}

function applyThingSpeakPreset(channelId, apiKey, name) {
    const chIdInput = document.getElementById('tsFormChannelId');
    const apiKeyInput = document.getElementById('tsFormApiKey');
    if (chIdInput) chIdInput.value = channelId;
    if (apiKeyInput) apiKeyInput.value = apiKey;
    document.getElementById('tsMapTemp').value = 'field1';
    document.getElementById('tsMapHum').value = 'field2';
    document.getElementById('tsMapLight').value = 'field3';
    document.getElementById('tsMapMoisture').value = 'field4';
}

function toggleApiKeyVisibility() {
    const input = document.getElementById('tsFormApiKey');
    if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
    }
}

async function testThingSpeakConnection() {
    const channelId = document.getElementById('tsFormChannelId').value.trim();
    const apiKey = document.getElementById('tsFormApiKey').value.trim();
    const banner = document.getElementById('tsModalTestBanner');
    const content = document.getElementById('tsModalTestContent');
    const spinner = document.getElementById('testConnSpinner');
    const btn = document.getElementById('btnTestConnection');

    if (!channelId) {
        alert('Please enter a valid ThingSpeak Channel ID.');
        return;
    }

    if (spinner) spinner.classList.remove('hidden');
    if (btn) btn.disabled = true;
    if (banner) {
        banner.classList.remove('hidden');
        banner.className = 'p-3 rounded-lg border bg-sky-950/40 border-sky-800 text-sky-200 text-xs';
    }
    if (content) {
        content.innerHTML = '<span class="animate-pulse">Connecting to ThingSpeak API...</span>';
    }

    try {
        const url = `https://api.thingspeak.com/channels/${channelId}/feeds.json?results=5${apiKey ? `&api_key=${apiKey}` : ''}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`ThingSpeak returned HTTP ${res.status} (${res.statusText})`);
        }
        const data = await res.json();
        if (!data || !data.channel) {
            throw new Error('Invalid response structure from ThingSpeak API');
        }

        const feeds = data.feeds || [];
        const lastFeed = feeds[feeds.length - 1];
        const lastDate = lastFeed?.created_at ? new Date(lastFeed.created_at).toUTCString() : 'None';
        const ageHours = lastFeed?.created_at ? Math.round((Date.now() - new Date(lastFeed.created_at).getTime()) / (1000 * 3600)) : 9999;
        const isRecent = ageHours < 2;

        if (banner) banner.className = 'p-3 rounded-lg border bg-emerald-950/40 border-emerald-800 text-emerald-200 text-xs space-y-1.5';
        if (content) {
            content.innerHTML = `
                <div class="flex items-center justify-between font-bold">
                    <span>✓ Connected: "${data.channel.name || 'Channel ' + channelId}"</span>
                    <span class="px-2 py-0.5 rounded text-[10px] ${isRecent ? 'bg-emerald-500 text-slate-900 font-bold' : 'bg-amber-500 text-slate-900 font-bold'}">
                        ${isRecent ? 'CONNECTED (LIVE)' : 'STALE (HISTORICAL)'}
                    </span>
                </div>
                <div class="text-[11px] text-slate-300">
                    Total Feeds: <b>${feeds.length}</b> &bull; Last Entry ID: <b>${data.channel.last_entry_id || 'N/A'}</b>
                </div>
                <div class="text-[11px] text-slate-300">
                    Latest Feed: <span class="font-mono text-sky-300">${lastDate}</span> (${isRecent ? 'Active Hardware' : '~' + Math.round(ageHours/24) + ' days ago'})
                </div>
            `;
        }
    } catch (err) {
        if (banner) banner.className = 'p-3 rounded-lg border bg-rose-950/40 border-rose-800 text-rose-200 text-xs space-y-1';
        if (content) {
            content.innerHTML = `
                <div class="font-bold">✕ Connection Test Failed</div>
                <div class="text-[11px] text-rose-300">${err.message}. If this is a private channel, verify that you provided the correct Read API Key.</div>
            `;
        }
    } finally {
        if (spinner) spinner.classList.add('hidden');
        if (btn) btn.disabled = false;
    }
}

async function handleSaveThingSpeakConfig(e) {
    e.preventDefault();
    const channelId = document.getElementById('tsFormChannelId').value.trim();
    const apiKey = document.getElementById('tsFormApiKey').value.trim();
    const results = parseInt(document.getElementById('tsFormResults').value, 10) || 20;

    const fieldMapping = {
        temperatureField: document.getElementById('tsMapTemp').value.trim() || 'field1',
        humidityField: document.getElementById('tsMapHum').value.trim() || 'field2',
        lightField: document.getElementById('tsMapLight').value.trim() || 'field3',
        moistureField: document.getElementById('tsMapMoisture').value.trim() || 'field4'
    };

    const saveBtn = document.getElementById('btnSaveTsConfig');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Connecting...';
    }

    try {
        const res = await fetch('/api/v1/thingspeak/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                channelId,
                readApiKey: apiKey,
                results,
                fieldMapping
            })
        });
        const result = await res.json();
        if (result.success) {
            closeConnectDeviceModal();
            await fetchThingSpeakLatest();
            alert(`ThingSpeak Channel #${channelId} connected successfully!`);
        } else {
            alert(`Failed to save configuration: ${result.error}`);
        }
    } catch (err) {
        alert(`Error saving ThingSpeak configuration: ${err.message}`);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Connect Channel';
        }
    }
}

// Boot application when DOM ready
window.addEventListener('DOMContentLoaded', initApp);
