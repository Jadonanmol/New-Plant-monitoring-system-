import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { store } from './lib/store.js';
import {
  calculateMoisturePercentage,
  evaluatePlantHealth,
  shouldTriggerIrrigation,
  evaluateAlerts
} from './lib/iot-rules.js';
import {
  parseThingSpeakPayload,
  determineConnectionStatus
} from './lib/thingspeak.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// In-memory queue for actuator commands awaiting ESP32 poll/ack
const pendingDeviceCommands = new Map();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static directory
app.use(express.static(__dirname));
app.use('/src/assets/images', express.static(path.join(__dirname, 'src', 'assets', 'images')));

// Broadcast to all connected WebSocket clients
function broadcast(eventType, payload) {
  const message = JSON.stringify({ event: eventType, data: payload, timestamp: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// -------------------------------------------------------------
// WEBSOCKET SERVER
// -------------------------------------------------------------
wss.on('connection', (ws, req) => {
  // Send initial snapshot on connection
  const snapshot = {
    plants: store.getPlants(),
    devices: store.getDevices(),
    actuators: store.getActuators(),
    alerts: store.getAlerts(),
    settings: store.getSettings(),
    latestTelemetry: store.getTelemetryHistory({ limit: 30 })
  };
  ws.send(JSON.stringify({ event: 'state:init', data: snapshot, timestamp: Date.now() }));

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      // Handle inbound message from WebSocket-enabled ESP32 or client
      if (parsed.event === 'device:telemetry') {
        handleIncomingTelemetry(parsed.deviceId, parsed.data, false);
      } else if (parsed.event === 'actuator:report') {
        const { actuatorId, reportedState, durationSeconds } = parsed.data;
        const updated = store.reportActuatorState(actuatorId, reportedState, durationSeconds, 'esp32_ws_report');
        broadcast('actuator:update', updated);
      }
    } catch (err) {
      console.warn('[WS] Malformed message received:', err.message);
    }
  });
});

// Helper to process incoming telemetry from both HTTP and WS
function handleIncomingTelemetry(deviceId, readings, isSimulated = false) {
  const device = store.getDeviceById(deviceId);
  if (!device && !isSimulated) {
    return { error: 'Unknown device. Please register device ID first.' };
  }

  // Calculate calibrated moisture if raw ADC was sent
  let processedMoisture = readings.moisture;
  if (typeof readings.rawMoistureAdc === 'number' && typeof processedMoisture !== 'number') {
    const dry = device?.calibration?.dryAdc || 3200;
    const wet = device?.calibration?.wetAdc || 1400;
    processedMoisture = calculateMoisturePercentage(readings.rawMoistureAdc, dry, wet);
  }

  const cleanReadings = {
    ...readings,
    moisture: processedMoisture
  };

  const { record, plant } = store.recordTelemetry(deviceId, cleanReadings, isSimulated);

  // Broadcast telemetry update
  broadcast('telemetry:update', {
    deviceId,
    plantId: plant?.id,
    record,
    device: store.getDeviceById(deviceId)
  });

  // Evaluate alerts
  const updatedDevice = store.getDeviceById(deviceId);
  const newAlerts = evaluateAlerts(plant, updatedDevice, cleanReadings);
  for (const alert of newAlerts) {
    const saved = store.addAlert(alert);
    broadcast('alert:new', saved);
  }

  // Check Automatic Irrigation Logic if enabled
  const settings = store.getSettings();
  const pump = store.getActuatorById('actuator_pump_01');

  if (settings.irrigation.autoMode && pump && pump.mode === 'auto') {
    const lastWateredHist = pump.history.find(h => h.action === 'ON');
    const lastWateredTime = lastWateredHist ? lastWateredHist.timestamp : null;

    const safetyCheck = shouldTriggerIrrigation(
      settings.irrigation,
      cleanReadings.moisture,
      cleanReadings.tankLevel,
      lastWateredTime
    );

    if (safetyCheck.allowed && pump.reportedState !== 'ON') {
      console.log(`[Auto-Irrigation] Triggering pump for ${safetyCheck.durationSeconds}s. Reason: ${safetyCheck.reason}`);
      triggerActuator('actuator_pump_01', 'ON', 'auto', safetyCheck.durationSeconds, 'auto_moisture_low');
    }
  }

  return { success: true, record };
}

// Actuator command helper
function triggerActuator(actuatorId, desiredState, mode, durationSeconds = null, triggeredBy = 'user') {
  const act = store.setActuatorCommand(actuatorId, desiredState, mode);
  if (!act) return null;

  broadcast('actuator:command', {
    actuator: act,
    command: { state: desiredState, durationSeconds, triggeredBy }
  });

  // Queue command for target device
  if (act.targetDeviceId) {
    if (!pendingDeviceCommands.has(act.targetDeviceId)) {
      pendingDeviceCommands.set(act.targetDeviceId, []);
    }
    pendingDeviceCommands.get(act.targetDeviceId).push({
      actuatorId,
      pin: act.pin,
      state: desiredState,
      durationSeconds,
      timestamp: Date.now()
    });
  }

  // In Demo Mode: simulate hardware acknowledgement
  const isDemo = store.getSettings().demoMode;
  if (isDemo) {
    setTimeout(() => {
      const updated = store.reportActuatorState(actuatorId, desiredState, durationSeconds, triggeredBy);
      broadcast('actuator:update', updated);

      // If pump was commanded ON with duration, schedule automatic turn OFF simulation
      if (desiredState === 'ON' && durationSeconds) {
        setTimeout(() => {
          store.setActuatorCommand(actuatorId, 'OFF', mode);
          const offUpdated = store.reportActuatorState(actuatorId, 'OFF', null, 'auto_duration_complete');
          broadcast('actuator:update', offUpdated);
        }, durationSeconds * 1000);
      }
    }, 400);
  }

  return act;
}

// -------------------------------------------------------------
// REST API ROUTES
// -------------------------------------------------------------

// Snapshot of all state
app.get('/api/v1/state', (req, res) => {
  res.json({
    plants: store.getPlants(),
    devices: store.getDevices(),
    actuators: store.getActuators(),
    alerts: store.getAlerts(),
    settings: store.getSettings()
  });
});

// PLANTS
app.get('/api/v1/plants', (req, res) => {
  const plants = store.getPlants().map(plant => {
    // Attach latest telemetry & health assessment
    const device = plant.assignedDeviceId ? store.getDeviceById(plant.assignedDeviceId) : null;
    const telemetry = device?.currentReadings || null;
    const health = evaluatePlantHealth(plant, telemetry);
    return { ...plant, telemetry, health, deviceStatus: device?.status || 'unassigned' };
  });
  res.json(plants);
});

app.post('/api/v1/plants', (req, res) => {
  const plant = req.body;
  if (!plant.name) return res.status(400).json({ error: 'Plant name is required' });
  const saved = store.savePlant(plant);
  broadcast('plant:update', saved);
  res.json(saved);
});

app.delete('/api/v1/plants/:id', (req, res) => {
  store.deletePlant(req.params.id);
  broadcast('plant:delete', { id: req.params.id });
  res.json({ success: true });
});

// DEVICES (ESP32 Management)
app.get('/api/v1/devices', (req, res) => {
  res.json(store.getDevices());
});

app.post('/api/v1/devices', (req, res) => {
  const device = req.body;
  if (!device.name || !device.id) {
    return res.status(400).json({ error: 'Device ID and Name are required' });
  }
  const saved = store.saveDevice(device);
  broadcast('device:update', saved);
  res.json(saved);
});

app.delete('/api/v1/devices/:id', (req, res) => {
  store.deleteDevice(req.params.id);
  broadcast('device:delete', { id: req.params.id });
  res.json({ success: true });
});

// ESP32 TELEMETRY INGESTION (HTTP POST)
app.post('/api/v1/devices/:id/telemetry', (req, res) => {
  const deviceId = req.params.id;
  const readings = req.body;
  const isSimulated = req.body.isSimulated === true;

  // Validate device
  const device = store.getDeviceById(deviceId);
  if (!device) {
    return res.status(404).json({ error: `ESP32 device '${deviceId}' not found. Register device first.` });
  }

  // Token validation if present
  const providedToken = req.headers['x-device-token'] || req.query.token;
  if (device.deviceToken && providedToken && providedToken !== device.deviceToken) {
    return res.status(401).json({ error: 'Invalid device authentication token' });
  }

  // Update Wi-Fi stats if transmitted
  if (typeof req.body.wifiRssi === 'number') device.wifiRssi = req.body.wifiRssi;
  if (req.body.ip) device.ipAddress = req.body.ip;

  const result = handleIncomingTelemetry(deviceId, readings, isSimulated);
  if (result.error) {
    return res.status(400).json(result);
  }

  // Return any queued commands for this ESP32
  const pending = pendingDeviceCommands.get(deviceId) || [];
  pendingDeviceCommands.set(deviceId, []); // Flush queue

  res.json({
    success: true,
    message: 'Telemetry received successfully',
    commands: pending,
    serverTime: Date.now()
  });
});

// ESP32 Commands Poll (HTTP GET)
app.get('/api/v1/devices/:id/commands', (req, res) => {
  const deviceId = req.params.id;
  const pending = pendingDeviceCommands.get(deviceId) || [];
  pendingDeviceCommands.set(deviceId, []);
  res.json({ commands: pending });
});

// SENSOR CALIBRATION
app.post('/api/v1/devices/:id/calibration', (req, res) => {
  const device = store.getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const { dryAdc, wetAdc, tankDepthCm } = req.body;
  if (typeof dryAdc === 'number') device.calibration.dryAdc = dryAdc;
  if (typeof wetAdc === 'number') device.calibration.wetAdc = wetAdc;
  if (typeof tankDepthCm === 'number') device.calibration.tankDepthCm = tankDepthCm;

  store.saveDevice(device);
  broadcast('device:update', device);
  res.json({ success: true, calibration: device.calibration });
});

// ACTUATORS
app.get('/api/v1/actuators', (req, res) => {
  res.json(store.getActuators());
});

app.post('/api/v1/actuators/command', (req, res) => {
  const { actuatorId, state, mode, durationSeconds } = req.body;
  if (!actuatorId || !state) {
    return res.status(400).json({ error: 'actuatorId and state (ON/OFF) are required' });
  }

  const act = triggerActuator(actuatorId, state, mode || 'manual', durationSeconds, 'user_manual');
  if (!act) return res.status(404).json({ error: 'Actuator not found' });

  res.json({ success: true, actuator: act });
});

app.post('/api/v1/actuators/report', (req, res) => {
  const { actuatorId, reportedState, durationSeconds } = req.body;
  if (!actuatorId || !reportedState) {
    return res.status(400).json({ error: 'actuatorId and reportedState required' });
  }

  const updated = store.reportActuatorState(actuatorId, reportedState, durationSeconds, 'esp32_http_report');
  if (!updated) return res.status(404).json({ error: 'Actuator not found' });

  broadcast('actuator:update', updated);
  res.json({ success: true, actuator: updated });
});

// EMERGENCY STOP
app.post('/api/v1/actuators/emergency-stop', (req, res) => {
  const actuators = store.getActuators();
  const stopped = [];
  for (const act of actuators) {
    store.setActuatorCommand(act.id, 'OFF', 'manual');
    const updated = store.reportActuatorState(act.id, 'OFF', null, 'emergency_stop');
    stopped.push(updated);
    broadcast('actuator:update', updated);
  }

  store.addAlert({
    severity: 'critical',
    type: 'EMERGENCY_STOP',
    title: 'Emergency Actuator Shutoff Triggered',
    message: 'All connected pumps, fans, and relays commanded OFF immediately.'
  });

  res.json({ success: true, message: 'All actuators stopped immediately', actuators: stopped });
});

// ALERTS
app.get('/api/v1/alerts', (req, res) => {
  res.json(store.getAlerts());
});

app.patch('/api/v1/alerts/:id/read', (req, res) => {
  const alert = store.markAlertRead(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  broadcast('alert:update', alert);
  res.json(alert);
});

app.post('/api/v1/alerts/clear', (req, res) => {
  store.clearAlerts();
  broadcast('alert:clear', {});
  res.json({ success: true });
});

// TELEMETRY HISTORY & EXPORT
app.get('/api/v1/telemetry/history', (req, res) => {
  const { deviceId, plantId, range, limit } = req.query;
  const history = store.getTelemetryHistory({
    deviceId,
    plantId,
    range: range || '24h',
    limit: limit ? parseInt(limit, 10) : 200
  });
  res.json(history);
});

app.get('/api/v1/telemetry/export.csv', (req, res) => {
  const { range } = req.query;
  const history = store.getTelemetryHistory({ range: range || 'all', limit: 5000 });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="smart_plant_telemetry_${Date.now()}.csv"`);

  let csv = 'Timestamp,ISO_Date,Device_ID,Plant_ID,Moisture_Pct,Temperature_C,Humidity_Pct,Light_Lux,Tank_Level_Pct,Soil_pH,Soil_EC,Is_Simulated\n';
  for (const row of history) {
    const iso = new Date(row.timestamp).toISOString();
    csv += `${row.timestamp},"${iso}","${row.deviceId || ''}","${row.plantId || ''}",${row.moisture ?? ''},${row.temperature ?? ''},${row.humidity ?? ''},${row.light ?? ''},${row.tankLevel ?? ''},${row.ph ?? ''},${row.ec ?? ''},${row.isSimulated ? 1 : 0}\n`;
  }
  res.send(csv);
});

// SETTINGS & SIMULATION MODE
app.get('/api/v1/settings', (req, res) => {
  res.json(store.getSettings());
});

app.post('/api/v1/settings', (req, res) => {
  const updated = store.updateSettings(req.body);
  broadcast('settings:update', updated);
  res.json(updated);
});

app.post('/api/v1/simulation/toggle', (req, res) => {
  const { enabled } = req.body;
  const settings = store.updateSettings({ demoMode: Boolean(enabled) });
  broadcast('settings:update', settings);

  // If disabling demo mode, mark simulated device as offline
  if (!enabled) {
    const devices = store.getDevices();
    const demoDev = devices.find(d => d.isSimulated);
    if (demoDev) {
      demoDev.status = 'offline';
      demoDev.currentReadings = null;
      store.saveDevice(demoDev);
      broadcast('device:update', demoDev);
    }
  }

  res.json({ success: true, demoMode: settings.demoMode });
});

// -------------------------------------------------------------
// THINGSPEAK REAL IoT INTEGRATION
// -------------------------------------------------------------
async function fetchThingSpeakData(channelId = '1729295', apiKey = '', results = 20) {
  const cleanId = String(channelId).trim();
  const cleanKey = apiKey ? String(apiKey).trim() : '';
  const url = `https://api.thingspeak.com/channels/${cleanId}/feeds.json?results=${results}${cleanKey ? `&api_key=${cleanKey}` : ''}`;
  
  const response = await fetch(url, { headers: { 'User-Agent': 'SmartPlant-IoT-Server/2.0' } });
  if (!response.ok) {
    throw new Error(`ThingSpeak API error ${response.status}: ${response.statusText}`);
  }
  const raw = await response.json();
  if (raw === -1 || raw === 0) {
    throw new Error('ThingSpeak channel authorization failed. Check Channel ID and Read API Key.');
  }
  return raw;
}

let lastThingSpeakPayload = null;

async function syncThingSpeakChannel() {
  const settings = store.getSettings();
  const tsConfig = settings.thingspeak || { channelId: '1729295', enabled: true };
  if (!tsConfig.enabled || !tsConfig.channelId) return null;

  try {
    const raw = await fetchThingSpeakData(tsConfig.channelId, tsConfig.readApiKey, tsConfig.results || 20);
    const parsed = parseThingSpeakPayload(raw, tsConfig.fieldMapping);
    const statusInfo = determineConnectionStatus(parsed, Date.now());

    lastThingSpeakPayload = {
      channel: parsed.channel,
      latest: parsed.latest,
      feeds: parsed.feeds,
      status: statusInfo,
      lastFetched: Date.now()
    };

    // Update settings in store
    store.updateSettings({
      thingspeak: {
        ...tsConfig,
        status: statusInfo.status,
        statusReason: statusInfo.reason,
        lastFetched: Date.now(),
        lastReadingTime: statusInfo.lastReadingTime || null
      }
    });

    // Ensure a device entry exists in store for this ThingSpeak channel
    const deviceId = `thingspeak_${tsConfig.channelId}`;
    let tsDevice = store.getDeviceById(deviceId);
    const deviceName = `ThingSpeak: ${parsed.channel.name || 'Channel ' + tsConfig.channelId}`;
    
    if (!tsDevice) {
      tsDevice = {
        id: deviceId,
        name: deviceName,
        location: 'ThingSpeak Cloud IoT Channel',
        deviceToken: `ts_${tsConfig.channelId}`,
        ipAddress: 'api.thingspeak.com',
        macAddress: `TS:${tsConfig.channelId.substring(0, 6)}`,
        firmwareVersion: 'ThingSpeak Gateway',
        wifiSsid: 'ThingSpeak Cloud Link',
        wifiRssi: -50,
        status: statusInfo.status === 'Connected' ? 'online' : (statusInfo.status === 'Stale' ? 'stale' : 'offline'),
        connectionStatus: statusInfo.status,
        lastSeen: parsed.latest ? parsed.latest.timestamp : null,
        isSimulated: false,
        channelId: tsConfig.channelId,
        supportedSensors: [
          { id: 'field1', name: parsed.channel.fieldLabels.field1 || 'Environmental Temperature', pin: 'Field 1', unit: '°C', isConnected: parsed.latest?.temperature !== null },
          { id: 'field2', name: parsed.channel.fieldLabels.field2 || 'Air Humidity', pin: 'Field 2', unit: '%', isConnected: parsed.latest?.humidity !== null },
          { id: 'field3', name: parsed.channel.fieldLabels.field3 || 'Light Level', pin: 'Field 3', unit: 'lx', isConnected: parsed.latest?.light !== null },
          { id: 'field4', name: parsed.channel.fieldLabels.field4 || 'Soil Moisture Level', pin: 'Field 4', unit: '%', isConnected: parsed.latest?.moisture !== null }
        ],
        currentReadings: parsed.latest ? {
          temperature: parsed.latest.temperature,
          humidity: parsed.latest.humidity,
          light: parsed.latest.light,
          moisture: parsed.latest.moisture
        } : null
      };
      store.saveDevice(tsDevice);
    } else {
      tsDevice.name = deviceName;
      tsDevice.status = statusInfo.status === 'Connected' ? 'online' : (statusInfo.status === 'Stale' ? 'stale' : 'offline');
      tsDevice.connectionStatus = statusInfo.status;
      tsDevice.lastSeen = parsed.latest ? parsed.latest.timestamp : tsDevice.lastSeen;
      tsDevice.currentReadings = parsed.latest ? {
        temperature: parsed.latest.temperature,
        humidity: parsed.latest.humidity,
        light: parsed.latest.light,
        moisture: parsed.latest.moisture
      } : null;
      store.saveDevice(tsDevice);
    }

    // Automatically associate primary plant if assigned to old demo device
    const plants = store.getPlants();
    if (plants.length > 0 && (!plants[0].assignedDeviceId || plants[0].assignedDeviceId === 'esp32_greenhouse_01')) {
      plants[0].assignedDeviceId = deviceId;
      store.savePlant(plants[0]);
    }

    // Broadcast to WebSocket clients
    broadcast('thingspeak:update', {
      channel: parsed.channel,
      latest: parsed.latest,
      feeds: parsed.feeds,
      status: statusInfo,
      device: tsDevice
    });

    return { parsed, statusInfo };
  } catch (err) {
    console.warn('[ThingSpeak Sync Error]', err.message);
    const errStatus = {
      status: 'Error',
      label: 'Error',
      reason: err.message,
      isRecent: false
    };
    store.updateSettings({
      thingspeak: {
        ...tsConfig,
        status: 'Error',
        statusReason: err.message,
        lastFetched: Date.now()
      }
    });
    broadcast('thingspeak:update', {
      status: errStatus,
      error: err.message
    });
    return { error: err.message, statusInfo: errStatus };
  }
}

// REST API for ThingSpeak
app.get('/api/v1/thingspeak/data', async (req, res) => {
  const settings = store.getSettings();
  const tsConfig = settings.thingspeak || {};
  const channelId = req.query.channelId || tsConfig.channelId || '1729295';
  const apiKey = req.query.apiKey !== undefined ? req.query.apiKey : tsConfig.readApiKey;
  const results = req.query.results ? parseInt(req.query.results, 10) : (tsConfig.results || 20);

  try {
    const raw = await fetchThingSpeakData(channelId, apiKey, results);
    const parsed = parseThingSpeakPayload(raw, tsConfig.fieldMapping);
    const statusInfo = determineConnectionStatus(parsed, Date.now());

    res.json({
      success: true,
      channel: parsed.channel,
      latest: parsed.latest,
      feeds: parsed.feeds,
      status: statusInfo,
      totalFeeds: parsed.totalFeeds,
      refreshIntervalSeconds: tsConfig.refreshIntervalSeconds || 20,
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      status: {
        status: 'Error',
        label: 'Error',
        reason: err.message,
        isRecent: false
      }
    });
  }
});

app.post('/api/v1/thingspeak/config', async (req, res) => {
  const { channelId, readApiKey, results, enabled, fieldMapping } = req.body;
  if (!channelId) return res.status(400).json({ error: 'Channel ID is required' });

  const currentSettings = store.getSettings();
  const updated = store.updateSettings({
    thingspeak: {
      ...(currentSettings.thingspeak || {}),
      channelId: String(channelId).trim(),
      readApiKey: readApiKey !== undefined ? String(readApiKey).trim() : (currentSettings.thingspeak?.readApiKey || ''),
      results: results ? parseInt(results, 10) : 20,
      enabled: enabled !== undefined ? Boolean(enabled) : true,
      fieldMapping: fieldMapping || currentSettings.thingspeak?.fieldMapping || {
        temperatureField: 'field1',
        humidityField: 'field2',
        lightField: 'field3',
        moistureField: 'field4'
      }
    }
  });

  // Immediately sync with the new configuration
  const syncResult = await syncThingSpeakChannel();
  res.json({
    success: true,
    settings: updated.thingspeak,
    syncResult
  });
});

app.post('/api/v1/thingspeak/refresh', async (req, res) => {
  const syncResult = await syncThingSpeakChannel();
  res.json({ success: true, syncResult });
});

// Periodic ThingSpeak Sync (Every 20 seconds)
setInterval(syncThingSpeakChannel, 20000);
setTimeout(syncThingSpeakChannel, 1500);

// -------------------------------------------------------------
// DEMO MODE HARDWARE SIMULATION ENGINE
// -------------------------------------------------------------
let simTick = 0;
setInterval(() => {
  const settings = store.getSettings();
  if (!settings.demoMode) return; // Do not run when demo mode is OFF

  simTick++;
  const demoDeviceId = 'esp32_greenhouse_01';
  const device = store.getDeviceById(demoDeviceId);
  if (!device) return;

  const current = device.currentReadings || {
    moisture: 58,
    temperature: 23.4,
    humidity: 62.8,
    light: 4850,
    tankLevel: 82,
    rawMoistureAdc: 2156,
    ph: 6.4,
    ec: 1.2
  };

  const pump = store.getActuatorById('actuator_pump_01');
  const isPumpOn = pump && pump.reportedState === 'ON';

  // Natural physics simulation:
  // If pump is ON, moisture rises fast (+2.5%), tank level drops (-0.8%)
  // If pump is OFF, soil slowly dries (-0.15% every 3s)
  let newMoisture = isPumpOn
    ? Math.min(88, current.moisture + 2.5)
    : Math.max(22, current.moisture - 0.12);

  let newTank = isPumpOn
    ? Math.max(5, current.tankLevel - 0.6)
    : current.tankLevel;

  // Temperature slight wave + random jitter
  const tempWave = Math.sin(simTick / 10) * 0.2;
  const newTemp = Math.round((23.0 + tempWave + (Math.random() * 0.2 - 0.1)) * 10) / 10;

  // Humidity inverse to temperature
  const newHum = Math.round((62.0 - tempWave * 2 + (Math.random() * 0.4 - 0.2)) * 10) / 10;

  // Light simulation with small ambient variation
  const newLight = Math.max(500, Math.min(15000, Math.floor(4800 + Math.sin(simTick / 8) * 800 + (Math.random() * 100 - 50))));

  // Calculate raw ADC corresponding to moisture
  const dryAdc = device.calibration.dryAdc || 3200;
  const wetAdc = device.calibration.wetAdc || 1400;
  const rawAdc = Math.round(dryAdc - (newMoisture / 100) * (dryAdc - wetAdc));

  handleIncomingTelemetry(demoDeviceId, {
    moisture: Math.round(newMoisture * 10) / 10,
    temperature: newTemp,
    humidity: newHum,
    light: newLight,
    tankLevel: Math.round(newTank),
    rawMoistureAdc: rawAdc,
    ph: 6.4,
    ec: 1.2,
    wifiRssi: -58 + Math.floor(Math.random() * 4 - 2),
    ip: '192.168.1.142'
  }, true);
}, 3000);

// Root entry point
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, HOST, () => {
  console.log(`[SmartPlant IoT] HTTP and WebSocket server active at http://${HOST}:${PORT}/`);
});
