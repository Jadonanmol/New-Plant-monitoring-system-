import test from 'node:test';
import assert from 'node:assert/strict';
import { parseThingSpeakPayload, determineConnectionStatus } from './thingspeak.js';

test('parseThingSpeakPayload correctly extracts channel and maps 4 fields', () => {
  const sampleResponse = {
    channel: {
      id: 1729295,
      name: 'Smart Agriculture',
      description: 'Visualize the environmental temperature, air humidity, light level and soil moisture level',
      field1: 'Environmental Temperature',
      field2: 'Air Humidity',
      field3: 'Light Level',
      field4: 'Soil Moisture Level',
      last_entry_id: 1365
    },
    feeds: [
      {
        created_at: '2022-07-12T06:42:36Z',
        entry_id: 1364,
        field1: '24.500',
        field2: '97.300',
        field3: '71.000',
        field4: '0.000'
      },
      {
        created_at: '2022-07-12T06:42:51Z',
        entry_id: 1365,
        field1: '24.500',
        field2: '97.200',
        field3: '72.000',
        field4: '0.000'
      }
    ]
  };

  const parsed = parseThingSpeakPayload(sampleResponse);

  assert.equal(parsed.channel.id, '1729295');
  assert.equal(parsed.channel.name, 'Smart Agriculture');
  assert.equal(parsed.feeds.length, 2);

  assert.deepEqual(parsed.latest, {
    entryId: 1365,
    createdAt: '2022-07-12T06:42:51Z',
    timestamp: new Date('2022-07-12T06:42:51Z').getTime(),
    temperature: 24.5,
    humidity: 97.2,
    light: 72,
    moisture: 0
  });
});

test('parseThingSpeakPayload handles missing or null fields gracefully with nulls', () => {
  const sampleWithMissing = {
    channel: { id: 12345, name: 'Test Channel' },
    feeds: [
      {
        created_at: '2026-11-05T12:00:00Z',
        entry_id: 1,
        field1: '21.4',
        field2: null, // missing humidity
        field3: '',   // empty light
        field4: undefined
      }
    ]
  };

  const parsed = parseThingSpeakPayload(sampleWithMissing);
  assert.equal(parsed.latest.temperature, 21.4);
  assert.equal(parsed.latest.humidity, null);
  assert.equal(parsed.latest.light, null);
  assert.equal(parsed.latest.moisture, null);
});

test('determineConnectionStatus evaluates Connected, Stale, Offline, and Error statuses', () => {
  const now = new Date('2026-11-05T20:00:00Z').getTime();

  // 1. Stale: Data from 2022 (Channel 1729295 actual data)
  const stalePayload = {
    channel: { id: 1729295, name: 'Smart Agriculture' },
    latest: { timestamp: new Date('2022-07-12T06:42:51Z').getTime() },
    feeds: [{ entryId: 1365 }]
  };
  const staleStatus = determineConnectionStatus(stalePayload, now);
  assert.equal(staleStatus.status, 'Stale');
  assert.equal(staleStatus.isRecent, false);
  assert.match(staleStatus.reason, /Stale/);

  // 2. Connected: Data from 5 minutes ago
  const connectedPayload = {
    channel: { id: 99999, name: 'Live Greenhouse' },
    latest: { timestamp: now - (5 * 60 * 1000) },
    feeds: [{ entryId: 200 }]
  };
  const connectedStatus = determineConnectionStatus(connectedPayload, now);
  assert.equal(connectedStatus.status, 'Connected');
  assert.equal(connectedStatus.isRecent, true);

  // 3. Offline: Channel exists with 0 feeds
  const offlinePayload = {
    channel: { id: 88888, name: 'Empty Channel' },
    latest: null,
    feeds: []
  };
  const offlineStatus = determineConnectionStatus(offlinePayload, now);
  assert.equal(offlineStatus.status, 'Offline');

  // 4. Error: Null payload
  const errorStatus = determineConnectionStatus(null, now);
  assert.equal(errorStatus.status, 'Error');
});
