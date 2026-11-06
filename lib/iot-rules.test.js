import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMoisturePercentage,
  evaluatePlantHealth,
  shouldTriggerIrrigation,
  evaluateAlerts
} from './iot-rules.js';

test('calculateMoisturePercentage handles capacitive ADC curve correctly', () => {
  // In capacitive sensors: high ADC = air/dry (0%), low ADC = water/wet (100%)
  const dryAdc = 3200;
  const wetAdc = 1400;

  // Exact dry
  assert.equal(calculateMoisturePercentage(3200, dryAdc, wetAdc), 0);
  // Exact wet
  assert.equal(calculateMoisturePercentage(1400, dryAdc, wetAdc), 100);
  // Midpoint: (3200 + 1400) / 2 = 2300
  assert.equal(calculateMoisturePercentage(2300, dryAdc, wetAdc), 50);
  // Out of bounds dry (e.g. 3500) clamped to 0
  assert.equal(calculateMoisturePercentage(3500, dryAdc, wetAdc), 0);
  // Out of bounds wet (e.g. 1000) clamped to 100
  assert.equal(calculateMoisturePercentage(1000, dryAdc, wetAdc), 100);
});

test('evaluatePlantHealth computes health score, status, and targeted advice', () => {
  const monstera = {
    id: 'p1',
    name: 'Monstera Deliciosa',
    preferredMoistureMin: 40,
    preferredMoistureMax: 70,
    preferredTempMin: 20,
    preferredTempMax: 28,
    preferredHumidityMin: 50,
    preferredHumidityMax: 80,
    preferredLightMin: 2000,
    preferredLightMax: 15000
  };

  // Case 1: Perfect conditions
  const nominal = evaluatePlantHealth(monstera, {
    moisture: 55,
    temperature: 24,
    humidity: 65,
    light: 5000
  });
  assert.equal(nominal.score, 100);
  assert.equal(nominal.status, 'Excellent');
  assert.equal(nominal.issues.length, 0);

  // Case 2: Severe underwatering and dry air
  const dryAndCold = evaluatePlantHealth(monstera, {
    moisture: 15, // 25 below min -> penalty ~30
    temperature: 15, // 5 below min -> penalty 15
    humidity: 25, // 25 below min -> penalty 20
    light: 500 // below min -> penalty 10
  });
  assert.ok(dryAndCold.score <= 45);
  assert.equal(dryAndCold.status, 'Critical');
  assert.ok(dryAndCold.issues.some(i => i.includes('Soil moisture is low')));
  assert.ok(dryAndCold.recommendations.some(r => r.includes('irrigation')));
});

test('shouldTriggerIrrigation enforces water tank safety and cooldown protections', () => {
  const config = {
    autoMode: true,
    moistureThreshold: 35,
    minTankLevel: 15,
    durationSeconds: 10,
    cooldownMinutes: 30
  };

  const now = 1700000000000;

  // Case 1: Moisture is fine (50%) -> Do not trigger
  const res1 = shouldTriggerIrrigation(config, 50, 80, null, now);
  assert.equal(res1.allowed, false);
  assert.match(res1.reason, /above watering threshold/);

  // Case 2: Moisture is low (25%), tank is full (80%), no previous watering -> Trigger!
  const res2 = shouldTriggerIrrigation(config, 25, 80, null, now);
  assert.equal(res2.allowed, true);
  assert.equal(res2.durationSeconds, 10);

  // Case 3: Moisture is low (25%), but tank is empty (10% < 15%) -> Safety shutoff!
  const res3 = shouldTriggerIrrigation(config, 25, 10, null, now);
  assert.equal(res3.allowed, false);
  assert.match(res3.reason, /below minimum safety threshold/);

  // Case 4: Cooldown active (watered 10 minutes ago, cooldown is 30m) -> Blocked!
  const tenMinutesAgo = now - 10 * 60 * 1000;
  const res4 = shouldTriggerIrrigation(config, 25, 80, tenMinutesAgo, now);
  assert.equal(res4.allowed, false);
  assert.match(res4.reason, /Pump cooldown active/);

  // Case 5: Cooldown expired (watered 45 minutes ago) -> Allowed!
  const fortyFiveMinutesAgo = now - 45 * 60 * 1000;
  const res5 = shouldTriggerIrrigation(config, 25, 80, fortyFiveMinutesAgo, now);
  assert.equal(res5.allowed, true);
});

test('evaluateAlerts detects critically dry soil and offline devices', () => {
  const now = 1700000000000;
  const device = {
    id: 'esp32_greenhouse_1',
    name: 'Greenhouse Node A',
    lastSeen: now - (5 * 60 * 1000) // 5 minutes ago (offline threshold is 2m)
  };
  const plant = {
    id: 'p1',
    name: 'Bonsai Ficus',
    preferredMoistureMin: 40
  };

  const alerts = evaluateAlerts(plant, device, { moisture: 18, tankLevel: 10, temperature: 38 }, now);
  assert.ok(alerts.length >= 3);
  assert.ok(alerts.some(a => a.type === 'DEVICE_OFFLINE'));
  assert.ok(alerts.some(a => a.type === 'SOIL_CRITICALLY_DRY'));
  assert.ok(alerts.some(a => a.type === 'WATER_TANK_LOW'));
});
