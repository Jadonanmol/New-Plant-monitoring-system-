/**
 * ThingSpeak IoT API Client & Payload Parser
 * Parses channel metadata and feeds, maps fields, determines connection status (Connected, Stale, Offline, Error).
 */

/**
 * Parses raw JSON response from ThingSpeak API.
 * @param {Object} raw - ThingSpeak JSON payload { channel: {...}, feeds: [...] }
 * @param {Object} config - Optional custom field mapping
 * @returns {Object} Structured data with latest reading, history, and channel metadata
 */
export function parseThingSpeakPayload(raw, config = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid ThingSpeak response payload');
  }

  const channel = raw.channel || {};
  const feeds = Array.isArray(raw.feeds) ? raw.feeds : [];

  // Default field mapping matching Channel 1729295
  const mapping = {
    temperatureField: config.temperatureField || 'field1',
    humidityField: config.humidityField || 'field2',
    lightField: config.lightField || 'field3',
    moistureField: config.moistureField || 'field4'
  };

  // Channel Metadata
  const channelInfo = {
    id: channel.id ? String(channel.id) : null,
    name: channel.name || 'Unnamed Channel',
    description: channel.description || '',
    latitude: channel.latitude || null,
    longitude: channel.longitude || null,
    createdAt: channel.created_at || null,
    updatedAt: channel.updated_at || null,
    lastEntryId: channel.last_entry_id || null,
    fieldLabels: {
      field1: channel.field1 || 'Field 1',
      field2: channel.field2 || 'Field 2',
      field3: channel.field3 || 'Field 3',
      field4: channel.field4 || 'Field 4'
    }
  };

  // Helper to parse numeric or null
  const parseVal = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  };

  // Parse historical feeds
  const parsedFeeds = feeds.map(feed => {
    const temp = parseVal(feed[mapping.temperatureField]);
    const hum = parseVal(feed[mapping.humidityField]);
    const light = parseVal(feed[mapping.lightField]);
    const moisture = parseVal(feed[mapping.moistureField]);

    const timestamp = feed.created_at ? new Date(feed.created_at).getTime() : Date.now();

    return {
      entryId: feed.entry_id,
      createdAt: feed.created_at,
      timestamp,
      temperature: temp,
      humidity: hum,
      light,
      moisture,
      rawFields: {
        field1: feed.field1 ?? null,
        field2: feed.field2 ?? null,
        field3: feed.field3 ?? null,
        field4: feed.field4 ?? null
      }
    };
  });

  // Extract latest valid reading (last item in feeds)
  let latest = null;
  if (parsedFeeds.length > 0) {
    const lastFeed = parsedFeeds[parsedFeeds.length - 1];
    latest = {
      entryId: lastFeed.entryId,
      createdAt: lastFeed.createdAt,
      timestamp: lastFeed.timestamp,
      temperature: lastFeed.temperature,
      humidity: lastFeed.humidity,
      light: lastFeed.light,
      moisture: lastFeed.moisture
    };
  }

  return {
    channel: channelInfo,
    latest,
    feeds: parsedFeeds,
    totalFeeds: parsedFeeds.length
  };
}

/**
 * Determines device connection status based on feeds and latest timestamp.
 * Statuses:
 * - 'Connected': Readings received and timestamp is recent (< 2 hours).
 * - 'Stale': Valid readings exist, but timestamp is older than recent threshold (e.g. historical data).
 * - 'Offline': Channel exists but has 0 data entries.
 * - 'Error': API error, invalid payload, or network failure.
 * 
 * @param {Object} parsed - Result from parseThingSpeakPayload
 * @param {number} now - Current time in ms (defaults to Date.now())
 * @param {number} staleThresholdMs - Threshold in ms before data is marked stale (default 2 hours)
 * @returns {Object} { status: string, label: string, reason: string, isRecent: boolean }
 */
export function determineConnectionStatus(parsed, now = Date.now(), staleThresholdMs = 2 * 60 * 60 * 1000) {
  if (!parsed || !parsed.channel || !parsed.channel.id) {
    return {
      status: 'Error',
      label: 'Error',
      reason: 'Failed to retrieve ThingSpeak channel information',
      isRecent: false
    };
  }

  if (!parsed.latest || parsed.feeds.length === 0) {
    return {
      status: 'Offline',
      label: 'Offline (No Feeds)',
      reason: `Channel #${parsed.channel.id} is registered but contains no sensor feeds.`,
      isRecent: false
    };
  }

  const lastTime = parsed.latest.timestamp;
  const ageMs = now - lastTime;
  const ageHours = Math.round((ageMs / (1000 * 60 * 60)) * 10) / 10;
  const dateStr = new Date(lastTime).toUTCString();

  // If age is less than staleThreshold (2 hours) and non-negative
  if (ageMs >= 0 && ageMs < staleThresholdMs) {
    return {
      status: 'Connected',
      label: 'Connected',
      reason: `Live sensor hardware active. Last reading received ${Math.round(ageMs / 1000)}s ago (${dateStr}).`,
      isRecent: true,
      lastReadingTime: dateStr,
      ageMs
    };
  }

  // If data exists but is older than 2 hours (or historical like July 2022)
  return {
    status: 'Stale',
    label: 'Stale (Historical Data)',
    reason: `Channel data retrieved successfully (${parsed.feeds.length} feeds). Status is Stale: last feed is historical from ${dateStr} (~${ageHours > 48 ? Math.round(ageHours / 24) + ' days' : ageHours + ' hours'} ago). Physical hardware node is currently inactive.`,
    isRecent: false,
    lastReadingTime: dateStr,
    ageMs
  };
}
