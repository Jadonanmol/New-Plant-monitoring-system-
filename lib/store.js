import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_PLANTS = [
  {
    id: 'plant_monstera_01',
    name: 'Monstera Deliciosa',
    species: 'Monstera deliciosa (Swiss Cheese Plant)',
    location: 'Living Room Bay Window',
    image: '/src/assets/images/plant_monstera_deliciosa_1793943423768.jpg',
    assignedDeviceId: 'esp32_greenhouse_01',
    assignedSensors: ['soil_moisture', 'dht22_temp', 'dht22_humidity', 'bh1750_light', 'hcsr04_tank'],
    preferredMoistureMin: 45,
    preferredMoistureMax: 75,
    preferredTempMin: 19,
    preferredTempMax: 29,
    preferredHumidityMin: 55,
    preferredHumidityMax: 85,
    preferredLightMin: 1500,
    preferredLightMax: 18000,
    createdAt: Date.now() - (7 * 24 * 3600 * 1000)
  },
  {
    id: 'plant_fiddle_02',
    name: 'Fiddle Leaf Fig',
    species: 'Ficus lyrata',
    location: 'Office Sun Corner',
    image: '/src/assets/images/plant_fiddle_leaf_fig_1793943424066.jpg',
    assignedDeviceId: 'esp32_office_02',
    assignedSensors: ['soil_moisture', 'dht22_temp', 'dht22_humidity', 'bh1750_light'],
    preferredMoistureMin: 35,
    preferredMoistureMax: 65,
    preferredTempMin: 20,
    preferredTempMax: 27,
    preferredHumidityMin: 40,
    preferredHumidityMax: 70,
    preferredLightMin: 2500,
    preferredLightMax: 22000,
    createdAt: Date.now() - (5 * 24 * 3600 * 1000)
  },
  {
    id: 'plant_snake_03',
    name: 'Sansevieria Lauren',
    species: 'Dracaena trifasciata (Snake Plant)',
    location: 'Master Bedroom Shelf',
    image: '/src/assets/images/plant_snake_plant_1793943424732.jpg',
    assignedDeviceId: null, // Unassigned to show clean setup flow
    assignedSensors: [],
    preferredMoistureMin: 20,
    preferredMoistureMax: 50,
    preferredTempMin: 15,
    preferredTempMax: 32,
    preferredHumidityMin: 30,
    preferredHumidityMax: 65,
    preferredLightMin: 500,
    preferredLightMax: 15000,
    createdAt: Date.now() - (3 * 24 * 3600 * 1000)
  },
  {
    id: 'plant_basil_04',
    name: 'Genovese Basil Pot',
    species: 'Ocimum basilicum',
    location: 'Kitchen Herb Station',
    image: '/src/assets/images/plant_basil_herb_1793943425020.jpg',
    assignedDeviceId: null,
    assignedSensors: [],
    preferredMoistureMin: 50,
    preferredMoistureMax: 80,
    preferredTempMin: 20,
    preferredTempMax: 30,
    preferredHumidityMin: 45,
    preferredHumidityMax: 75,
    preferredLightMin: 3000,
    preferredLightMax: 35000,
    createdAt: Date.now() - (1 * 24 * 3600 * 1000)
  }
];

const DEFAULT_DEVICES = [
  {
    id: 'esp32_greenhouse_01',
    name: 'ESP32 Hydro Node #1',
    location: 'Living Room Greenhouse',
    deviceToken: 'tok_esp32_gh01_9f4b12',
    ipAddress: '192.168.1.142',
    macAddress: '24:6F:28:AB:C1:20',
    firmwareVersion: 'v2.4.1-iot',
    wifiSsid: 'Greenhouse_IoT_2.4G',
    wifiRssi: -58, // Good signal dBm
    status: 'online', // 'online' | 'offline'
    lastSeen: Date.now() - 4000, // 4 seconds ago
    isSimulated: true, // starts in demo mode until physical ESP32 connects
    supportedSensors: [
      { id: 'soil_moisture', name: 'Capacitive Soil Moisture', pin: 'GPIO 34 (ADC1_CH6)', unit: '%', isConnected: true },
      { id: 'dht22_temp', name: 'DHT22 Temperature', pin: 'GPIO 4', unit: '°C', isConnected: true },
      { id: 'dht22_humidity', name: 'DHT22 Humidity', pin: 'GPIO 4', unit: '%', isConnected: true },
      { id: 'bh1750_light', name: 'BH1750 Ambient Light', pin: 'GPIO 21 (SDA) / 22 (SCL)', unit: 'lux', isConnected: true },
      { id: 'hcsr04_tank', name: 'HC-SR04 Water Level', pin: 'Trig: GPIO 12, Echo: GPIO 14', unit: '%', isConnected: true }
    ],
    calibration: {
      dryAdc: 3200,
      wetAdc: 1400,
      tankDepthCm: 30,
      sensorOffsetCm: 4
    },
    currentReadings: {
      moisture: 58,
      temperature: 23.4,
      humidity: 62.8,
      light: 4850,
      tankLevel: 82,
      rawMoistureAdc: 2156,
      ph: 6.4,
      ec: 1.2
    }
  },
  {
    id: 'esp32_office_02',
    name: 'ESP32 Bench Node #2',
    location: 'Office Sun Corner',
    deviceToken: 'tok_esp32_off02_7a18cc',
    ipAddress: '192.168.1.148',
    macAddress: '24:6F:28:DD:14:8A',
    firmwareVersion: 'v2.4.1-iot',
    wifiSsid: 'Office_Guest_IoT',
    wifiRssi: -72,
    status: 'offline', // Offline demonstration
    lastSeen: Date.now() - (45 * 60 * 1000), // 45 minutes ago
    isSimulated: false,
    supportedSensors: [
      { id: 'soil_moisture', name: 'Capacitive Soil Moisture', pin: 'GPIO 34', unit: '%', isConnected: false },
      { id: 'dht22_temp', name: 'DHT22 Temperature', pin: 'GPIO 4', unit: '°C', isConnected: false },
      { id: 'dht22_humidity', name: 'DHT22 Humidity', pin: 'GPIO 4', unit: '%', isConnected: false },
      { id: 'bh1750_light', name: 'BH1750 Ambient Light', pin: 'I2C', unit: 'lux', isConnected: false }
    ],
    calibration: {
      dryAdc: 3150,
      wetAdc: 1450,
      tankDepthCm: 25,
      sensorOffsetCm: 3
    },
    currentReadings: null // Empty because offline
  }
];

const DEFAULT_ACTUATORS = [
  {
    id: 'actuator_pump_01',
    name: 'Submersible Water Pump',
    type: 'pump',
    targetDeviceId: 'esp32_greenhouse_01',
    pin: 'GPIO 26 (Relay CH1)',
    mode: 'auto', // 'auto' | 'manual'
    desiredState: 'OFF', // 'ON' | 'OFF'
    reportedState: 'OFF', // Actual reported pin state from hardware
    lastCommandTime: Date.now() - 3600000,
    lastConfirmedTime: Date.now() - 3600000,
    runtimeLimitSeconds: 20,
    history: [
      { id: 'hist_1', action: 'OFF', durationSeconds: 8, triggeredBy: 'auto_moisture_restored', timestamp: Date.now() - 3600000 },
      { id: 'hist_2', action: 'ON', durationSeconds: 8, triggeredBy: 'auto_low_moisture_trigger', timestamp: Date.now() - 3608000 }
    ]
  },
  {
    id: 'actuator_fan_01',
    name: 'Air Circulation & Cooling Fan',
    type: 'fan',
    targetDeviceId: 'esp32_greenhouse_01',
    pin: 'GPIO 27 (Relay CH2)',
    mode: 'auto',
    desiredState: 'OFF',
    reportedState: 'OFF',
    lastCommandTime: Date.now() - 7200000,
    lastConfirmedTime: Date.now() - 7200000,
    runtimeLimitSeconds: 300,
    history: []
  },
  {
    id: 'actuator_lights_01',
    name: 'Full Spectrum Grow Lights',
    type: 'light',
    targetDeviceId: 'esp32_greenhouse_01',
    pin: 'GPIO 25 (Relay CH3 / PWM)',
    mode: 'manual',
    desiredState: 'ON',
    reportedState: 'ON',
    lastCommandTime: Date.now() - 14400000,
    lastConfirmedTime: Date.now() - 14400000,
    runtimeLimitSeconds: 43200, // 12h
    history: [
      { id: 'hist_3', action: 'ON', durationSeconds: null, triggeredBy: 'manual_user', timestamp: Date.now() - 14400000 }
    ]
  },
  {
    id: 'actuator_humidifier_01',
    name: 'Ultrasonic Humidifier',
    type: 'humidifier',
    targetDeviceId: 'esp32_greenhouse_01',
    pin: 'GPIO 33 (Relay CH4)',
    mode: 'auto',
    desiredState: 'OFF',
    reportedState: 'OFF',
    lastCommandTime: Date.now() - 86400000,
    lastConfirmedTime: Date.now() - 86400000,
    runtimeLimitSeconds: 600,
    history: []
  }
];

const DEFAULT_SETTINGS = {
  irrigation: {
    autoMode: true,
    moistureThreshold: 40,
    durationSeconds: 8,
    cooldownMinutes: 30,
    minTankLevel: 15,
    maxDailyCycles: 10
  },
  mqtt: {
    enabled: true,
    brokerUrl: 'wss://broker.emqx.io:8084/mqtt',
    tcpBrokerUrl: 'mqtt://broker.emqx.io:1883',
    topicTelemetry: 'smartplant/+/telemetry',
    topicActuators: 'smartplant/+/actuators',
    topicStatus: 'smartplant/+/status',
    keepAlive: 60
  },
  notifications: {
    inApp: true,
    emailEnabled: false,
    emailAddress: '',
    telegramEnabled: false,
    telegramChatId: '',
    telegramBotToken: ''
  },
  theme: 'dark', // 'dark' | 'light'
  demoMode: false, // Default to Real Hardware / ThingSpeak mode
  thingspeak: {
    enabled: true,
    channelId: '1729295',
    readApiKey: '',
    results: 20,
    fieldMapping: {
      temperatureField: 'field1',
      humidityField: 'field2',
      lightField: 'field3',
      moistureField: 'field4'
    },
    refreshIntervalSeconds: 20,
    status: 'Stale',
    lastFetched: null,
    lastReadingTime: null,
    statusReason: ''
  }
};

// Seed historical telemetry points for realistic trend charts
function generateInitialTelemetryHistory() {
  const points = [];
  const now = Date.now();
  const intervals = 60; // 60 data points (every 20 minutes across 20 hours)
  
  let moisture = 68;
  let temp = 22.0;
  let hum = 65;
  let light = 3200;
  let tank = 88;

  for (let i = intervals; i >= 0; i--) {
    const timestamp = now - (i * 20 * 60 * 1000);
    // Slight realistic drift
    moisture = Math.max(38, Math.min(85, moisture - (Math.random() * 0.8 - 0.2)));
    temp = Math.max(18, Math.min(29, temp + (Math.sin(i / 5) * 0.4) + (Math.random() * 0.2 - 0.1)));
    hum = Math.max(45, Math.min(82, hum + (Math.cos(i / 6) * 0.5) + (Math.random() * 0.4 - 0.2)));
    light = Math.max(0, Math.min(18000, Math.floor(4000 + Math.sin(i / 4) * 3500 + (Math.random() * 400 - 200))));
    tank = Math.max(60, Math.min(95, tank - (Math.random() * 0.1)));

    points.push({
      id: `tel_seed_${i}`,
      deviceId: 'esp32_greenhouse_01',
      plantId: 'plant_monstera_01',
      timestamp,
      isSimulated: true,
      moisture: Math.round(moisture * 10) / 10,
      temperature: Math.round(temp * 10) / 10,
      humidity: Math.round(hum * 10) / 10,
      light,
      tankLevel: Math.round(tank),
      ph: 6.5,
      ec: 1.2
    });
  }
  return points;
}

class IoTStore {
  constructor() {
    this.data = this.loadDatabase();
  }

  loadDatabase() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          plants: parsed.plants || DEFAULT_PLANTS,
          devices: parsed.devices || DEFAULT_DEVICES,
          actuators: parsed.actuators || DEFAULT_ACTUATORS,
          settings: {
            ...DEFAULT_SETTINGS,
            ...(parsed.settings || {}),
            thingspeak: {
              ...DEFAULT_SETTINGS.thingspeak,
              ...((parsed.settings && parsed.settings.thingspeak) || {})
            }
          },
          alerts: parsed.alerts || [],
          telemetryHistory: parsed.telemetryHistory || generateInitialTelemetryHistory()
        };
      }
    } catch (err) {
      console.warn('[IoTStore] Error loading database file, falling back to defaults:', err.message);
    }

    const initial = {
      plants: DEFAULT_PLANTS,
      devices: DEFAULT_DEVICES,
      actuators: DEFAULT_ACTUATORS,
      settings: DEFAULT_SETTINGS,
      alerts: [
        {
          id: 'alert_init_1',
          severity: 'info',
          type: 'SYSTEM_READY',
          title: 'Smart Plant IoT Engine Online',
          message: 'ESP32 IoT telemetry backend active. Ready for hardware communication.',
          timestamp: Date.now() - 60000,
          read: false
        }
      ],
      telemetryHistory: generateInitialTelemetryHistory()
    };
    this.persist(initial);
    return initial;
  }

  persist(dataToSave = this.data) {
    try {
      fs.writeFileSync(DB_PATH, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('[IoTStore] Failed to write database file:', err.message);
    }
  }

  // PLANTS
  getPlants() {
    return this.data.plants;
  }

  getPlantById(id) {
    return this.data.plants.find(p => p.id === id);
  }

  savePlant(plant) {
    const existingIndex = this.data.plants.findIndex(p => p.id === plant.id);
    if (existingIndex >= 0) {
      this.data.plants[existingIndex] = { ...this.data.plants[existingIndex], ...plant, updatedAt: Date.now() };
    } else {
      const newPlant = {
        id: plant.id || `plant_${Date.now()}`,
        createdAt: Date.now(),
        ...plant
      };
      this.data.plants.push(newPlant);
    }
    this.persist();
    return plant;
  }

  deletePlant(id) {
    this.data.plants = this.data.plants.filter(p => p.id !== id);
    this.persist();
    return true;
  }

  // DEVICES
  getDevices() {
    return this.data.devices;
  }

  getDeviceById(id) {
    return this.data.devices.find(d => d.id === id);
  }

  saveDevice(device) {
    const existingIndex = this.data.devices.findIndex(d => d.id === device.id);
    if (existingIndex >= 0) {
      this.data.devices[existingIndex] = { ...this.data.devices[existingIndex], ...device, updatedAt: Date.now() };
    } else {
      const newDevice = {
        id: device.id || `esp32_${Date.now()}`,
        deviceToken: device.deviceToken || `tok_${Math.random().toString(36).substring(2, 10)}`,
        status: 'offline',
        lastSeen: null,
        isSimulated: false,
        createdAt: Date.now(),
        ...device
      };
      this.data.devices.push(newDevice);
    }
    this.persist();
    return device;
  }

  deleteDevice(id) {
    this.data.devices = this.data.devices.filter(d => d.id !== id);
    // Unassign device from plants
    this.data.plants.forEach(p => {
      if (p.assignedDeviceId === id) p.assignedDeviceId = null;
    });
    this.persist();
    return true;
  }

  // TELEMETRY
  recordTelemetry(deviceId, readings, isSimulated = false) {
    const device = this.getDeviceById(deviceId);
    const now = Date.now();

    if (device) {
      device.lastSeen = now;
      device.status = 'online';
      device.currentReadings = { ...device.currentReadings, ...readings };
      device.isSimulated = isSimulated;
    }

    // Find assigned plant
    const plant = this.data.plants.find(p => p.assignedDeviceId === deviceId);

    const record = {
      id: `tel_${now}_${Math.random().toString(36).substring(2, 6)}`,
      deviceId,
      plantId: plant?.id || null,
      timestamp: now,
      isSimulated,
      ...readings
    };

    this.data.telemetryHistory.push(record);

    // Keep history capped to last 2000 points
    if (this.data.telemetryHistory.length > 2000) {
      this.data.telemetryHistory.shift();
    }

    this.persist();
    return { record, device, plant };
  }

  getTelemetryHistory({ deviceId, plantId, range = '24h', limit = 200 } = {}) {
    const now = Date.now();
    let cutoff = now - (24 * 3600 * 1000); // default 24h
    if (range === '1h') cutoff = now - (3600 * 1000);
    else if (range === '6h') cutoff = now - (6 * 3600 * 1000);
    else if (range === '7d') cutoff = now - (7 * 24 * 3600 * 1000);
    else if (range === '30d') cutoff = now - (30 * 24 * 3600 * 1000);
    else if (range === 'all') cutoff = 0;

    let points = this.data.telemetryHistory.filter(t => t.timestamp >= cutoff);
    if (deviceId) points = points.filter(t => t.deviceId === deviceId);
    if (plantId) points = points.filter(t => t.plantId === plantId);

    return points.slice(-limit);
  }

  // ACTUATORS
  getActuators() {
    return this.data.actuators;
  }

  getActuatorById(id) {
    return this.data.actuators.find(a => a.id === id);
  }

  setActuatorCommand(id, desiredState, mode) {
    const act = this.getActuatorById(id);
    if (!act) return null;

    if (desiredState) act.desiredState = desiredState;
    if (mode) act.mode = mode;
    act.lastCommandTime = Date.now();

    this.persist();
    return act;
  }

  reportActuatorState(id, reportedState, durationSeconds = null, triggeredBy = 'hardware_report') {
    const act = this.getActuatorById(id);
    if (!act) return null;

    const previousState = act.reportedState;
    act.reportedState = reportedState;
    act.lastConfirmedTime = Date.now();

    if (previousState !== reportedState) {
      act.history.unshift({
        id: `acthist_${Date.now()}`,
        action: reportedState,
        durationSeconds,
        triggeredBy,
        timestamp: Date.now()
      });
      if (act.history.length > 50) act.history.pop();
    }

    this.persist();
    return act;
  }

  // ALERTS
  getAlerts() {
    return this.data.alerts;
  }

  addAlert(alert) {
    // Avoid duplicate unread alerts of the same type for the same target
    const existing = this.data.alerts.find(
      a => a.type === alert.type && a.deviceId === alert.deviceId && a.plantId === alert.plantId && !a.read
    );
    if (existing) {
      existing.timestamp = alert.timestamp || Date.now();
      existing.message = alert.message;
      this.persist();
      return existing;
    }

    const newAlert = {
      id: alert.id || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      read: false,
      ...alert
    };
    this.data.alerts.unshift(newAlert);
    if (this.data.alerts.length > 100) this.data.alerts.pop();
    this.persist();
    return newAlert;
  }

  markAlertRead(id) {
    const alert = this.data.alerts.find(a => a.id === id);
    if (alert) {
      alert.read = true;
      this.persist();
    }
    return alert;
  }

  clearAlerts() {
    this.data.alerts = [];
    this.persist();
    return true;
  }

  // SETTINGS
  getSettings() {
    return this.data.settings;
  }

  updateSettings(updates) {
    this.data.settings = {
      ...this.data.settings,
      ...updates,
      irrigation: { ...this.data.settings.irrigation, ...(updates.irrigation || {}) },
      mqtt: { ...this.data.settings.mqtt, ...(updates.mqtt || {}) },
      notifications: { ...this.data.settings.notifications, ...(updates.notifications || {}) },
      thingspeak: { ...(this.data.settings.thingspeak || DEFAULT_SETTINGS.thingspeak), ...(updates.thingspeak || {}) }
    };
    this.persist();
    return this.data.settings;
  }
}

export const store = new IoTStore();
