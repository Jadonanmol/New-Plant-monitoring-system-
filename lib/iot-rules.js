/**
 * Core IoT business logic, sensor math, irrigation safety rules, and plant health evaluation.
 * Decoupled from UI and network layers for deterministic testing.
 */

/**
 * Calculates soil moisture percentage from raw ADC value and calibration points.
 * Capacitive soil moisture sensors return higher ADC for dry air/soil and lower ADC for wet soil/water.
 * @param {number} rawAdc - Current ADC reading (e.g. 0 - 4095 for ESP32 12-bit ADC)
 * @param {number} dryAdc - Calibration value in completely dry soil / air
 * @param {number} wetAdc - Calibration value in fully saturated wet soil / water
 * @returns {number} Calibrated moisture percentage (0 - 100%)
 */
export function calculateMoisturePercentage(rawAdc, dryAdc = 3200, wetAdc = 1400) {
  if (dryAdc === wetAdc) return 50;
  
  // Standard capacitive sensor: rawAdc >= dryAdc is 0%, rawAdc <= wetAdc is 100%
  let percentage;
  if (dryAdc > wetAdc) {
    percentage = ((dryAdc - rawAdc) / (dryAdc - wetAdc)) * 100;
  } else {
    // Inverted sensor (resistive)
    percentage = ((rawAdc - dryAdc) / (wetAdc - dryAdc)) * 100;
  }

  return Math.max(0, Math.min(100, Math.round(percentage)));
}

/**
 * Evaluates plant health based on plant-specific thresholds and actual telemetry.
 * @param {Object} plant - Plant configuration and preferred ranges
 * @param {Object} telemetry - Current sensor readings
 * @returns {Object} Health score, status, issues, causes, and recommendations
 */
export function evaluatePlantHealth(plant, telemetry) {
  if (!telemetry || Object.keys(telemetry).length === 0) {
    return {
      score: 50,
      status: 'Unknown',
      summary: 'Waiting for sensor hardware data',
      issues: ['No active sensor telemetry received'],
      recommendations: ['Connect ESP32 device and verify sensor wiring']
    };
  }

  const issues = [];
  const causes = [];
  const recommendations = [];
  let score = 100;

  // 1. Soil Moisture Evaluation
  const prefMoistureMin = plant.preferredMoistureMin ?? 40;
  const prefMoistureMax = plant.preferredMoistureMax ?? 75;

  if (typeof telemetry.moisture === 'number') {
    if (telemetry.moisture < prefMoistureMin) {
      const diff = prefMoistureMin - telemetry.moisture;
      const penalty = Math.min(35, Math.round(diff * 1.2));
      score -= penalty;
      issues.push(`Soil moisture is low (${telemetry.moisture}%, target: ${prefMoistureMin}-${prefMoistureMax}%)`);
      causes.push('Substrate under-watering or high transpiration rate');
      recommendations.push(`Initiate irrigation cycle or enable automatic watering for ${plant.name}`);
    } else if (telemetry.moisture > prefMoistureMax) {
      const diff = telemetry.moisture - prefMoistureMax;
      const penalty = Math.min(30, Math.round(diff * 1.0));
      score -= penalty;
      issues.push(`Soil moisture is excessively high (${telemetry.moisture}%, target: ${prefMoistureMin}-${prefMoistureMax}%)`);
      causes.push('Over-watering or poor pot drainage causing root hypoxia risk');
      recommendations.push('Pause irrigation and check drainage holes at the base of the pot');
    }
  }

  // 2. Temperature Evaluation
  const prefTempMin = plant.preferredTempMin ?? 18;
  const prefTempMax = plant.preferredTempMax ?? 28;

  if (typeof telemetry.temperature === 'number') {
    if (telemetry.temperature < prefTempMin) {
      const penalty = Math.min(25, (prefTempMin - telemetry.temperature) * 3);
      score -= penalty;
      issues.push(`Temperature is below optimal (${telemetry.temperature}°C, target: ${prefTempMin}-${prefTempMax}°C)`);
      causes.push('Cold drafts, ambient night chill, or outdoor exposure');
      recommendations.push('Move plant away from cold window drafts or activate greenhouse heater');
    } else if (telemetry.temperature > prefTempMax) {
      const penalty = Math.min(25, (telemetry.temperature - prefTempMax) * 3);
      score -= penalty;
      issues.push(`Temperature is above optimal (${telemetry.temperature}°C, target: ${prefTempMin}-${prefTempMax}°C)`);
      causes.push('Direct intense sun exposure or unventilated enclosure');
      recommendations.push('Activate cooling fan or provide shade diffusion');
    }
  }

  // 3. Humidity Evaluation
  const prefHumMin = plant.preferredHumidityMin ?? 45;
  const prefHumMax = plant.preferredHumidityMax ?? 80;

  if (typeof telemetry.humidity === 'number') {
    if (telemetry.humidity < prefHumMin) {
      const penalty = Math.min(20, (prefHumMin - telemetry.humidity) * 0.8);
      score -= penalty;
      issues.push(`Air humidity is low (${telemetry.humidity}%, target: ${prefHumMin}-${prefHumMax}%)`);
      causes.push('Dry indoor heating or dry season climate');
      recommendations.push('Turn on ultrasonic humidifier or mist foliage');
    } else if (telemetry.humidity > prefHumMax) {
      const penalty = Math.min(15, (telemetry.humidity - prefHumMax) * 0.6);
      score -= penalty;
      issues.push(`Air humidity is excessively high (${telemetry.humidity}%, target: ${prefHumMin}-${prefHumMax}%)`);
      causes.push('Stagnant damp air with fungal spore growth risk');
      recommendations.push('Increase air circulation around plant foliage');
    }
  }

  // 4. Light Evaluation
  if (typeof telemetry.light === 'number') {
    const minLux = plant.preferredLightMin ?? 1000;
    const maxLux = plant.preferredLightMax ?? 25000;

    if (telemetry.light < minLux) {
      score -= 10;
      issues.push(`Light intensity is insufficient (${telemetry.light} lux, minimum: ${minLux} lux)`);
      causes.push('Insufficient direct or indirect photon exposure');
      recommendations.push('Activate auxiliary grow lights for at least 4 hours');
    } else if (telemetry.light > maxLux) {
      score -= 10;
      issues.push(`Light intensity is excessive (${telemetry.light} lux, maximum: ${maxLux} lux)`);
      causes.push('Direct harsh midday sunlight causing leaf scorch risk');
      recommendations.push('Lower shade blinds or move further from light fixture');
    }
  }

  // Clamp score
  const finalScore = Math.max(5, Math.min(100, Math.round(score)));

  let status = 'Excellent';
  if (finalScore < 45) {
    status = 'Critical';
  } else if (finalScore < 70) {
    status = 'Fair';
  } else if (finalScore < 85) {
    status = 'Good';
  }

  return {
    score: finalScore,
    status,
    summary: issues.length === 0 ? 'All environmental parameters within optimal range' : issues[0],
    issues,
    causes,
    recommendations: recommendations.length > 0 ? recommendations : ['Maintain current environmental balance']
  };
}

/**
 * Automatic irrigation safety gate and trigger validator.
 * Validates whether the water pump can be safely turned ON.
 * @param {Object} config - Irrigation settings
 * @param {number} soilMoisture - Current soil moisture %
 * @param {number} tankLevel - Current water tank level %
 * @param {number|null} lastWateredTimestamp - Timestamp of last watering session (ms)
 * @param {number} currentTimestamp - Current timestamp (ms)
 * @returns {Object} { allowed: boolean, reason: string, durationSeconds: number }
 */
export function shouldTriggerIrrigation(config, soilMoisture, tankLevel, lastWateredTimestamp = null, currentTimestamp = Date.now()) {
  const {
    autoMode = true,
    moistureThreshold = 35,
    minTankLevel = 15,
    durationSeconds = 8,
    cooldownMinutes = 30,
    maxDailyCycles = 12
  } = config;

  if (!autoMode) {
    return { allowed: false, reason: 'Automatic watering mode is disabled', durationSeconds: 0 };
  }

  // 1. Water tank safety check
  if (typeof tankLevel === 'number' && tankLevel < minTankLevel) {
    return {
      allowed: false,
      reason: `Water tank level (${tankLevel}%) is below minimum safety threshold (${minTankLevel}%). Pump protected from dry run.`,
      durationSeconds: 0
    };
  }

  // 2. Cooldown check
  if (lastWateredTimestamp) {
    const elapsedMinutes = (currentTimestamp - lastWateredTimestamp) / (1000 * 60);
    if (elapsedMinutes < cooldownMinutes) {
      const waitRemaining = Math.ceil(cooldownMinutes - elapsedMinutes);
      return {
        allowed: false,
        reason: `Pump cooldown active. Please wait ${waitRemaining} more minute(s) to allow soil absorption.`,
        durationSeconds: 0
      };
    }
  }

  // 3. Moisture trigger
  if (typeof soilMoisture === 'number') {
    if (soilMoisture >= moistureThreshold) {
      return {
        allowed: false,
        reason: `Soil moisture (${soilMoisture}%) is above watering threshold (${moistureThreshold}%)`,
        durationSeconds: 0
      };
    }
  } else {
    return {
      allowed: false,
      reason: 'No valid soil moisture telemetry available to trigger pump',
      durationSeconds: 0
    };
  }

  return {
    allowed: true,
    reason: `Soil moisture (${soilMoisture}%) is below threshold (${moistureThreshold}%). Starting ${durationSeconds}s cycle.`,
    durationSeconds: Math.min(30, Math.max(1, durationSeconds))
  };
}

/**
 * Evaluates telemetry against thresholds and produces alert objects.
 * @param {Object} plant
 * @param {Object} device
 * @param {Object} telemetry
 * @param {number} now
 * @returns {Array<Object>} List of alerts to trigger
 */
export function evaluateAlerts(plant, device, telemetry, now = Date.now()) {
  const alerts = [];

  // Check device offline
  if (device && device.lastSeen) {
    const offlineThresholdMs = 2 * 60 * 1000; // 2 minutes
    if (now - device.lastSeen > offlineThresholdMs) {
      alerts.push({
        id: `alert_dev_offline_${device.id}`,
        deviceId: device.id,
        plantId: plant?.id,
        severity: 'critical',
        type: 'DEVICE_OFFLINE',
        title: `ESP32 Device Offline: ${device.name || device.id}`,
        message: `Device has not transmitted telemetry in over ${Math.round((now - device.lastSeen) / 1000)}s.`,
        timestamp: now
      });
    }
  }

  if (!telemetry) return alerts;

  // Soil moisture critical dry
  if (typeof telemetry.moisture === 'number' && telemetry.moisture < (plant?.preferredMoistureMin ?? 30) - 10) {
    alerts.push({
      id: `alert_moisture_dry_${plant?.id || 'gen'}`,
      deviceId: device?.id,
      plantId: plant?.id,
      severity: 'critical',
      type: 'SOIL_CRITICALLY_DRY',
      title: 'Critically Dry Soil',
      message: `${plant?.name || 'Plant'} soil moisture dropped to ${telemetry.moisture}%. Immediate watering required.`,
      timestamp: now
    });
  }

  // Water tank low
  if (typeof telemetry.tankLevel === 'number' && telemetry.tankLevel < 20) {
    alerts.push({
      id: `alert_tank_low_${device?.id || 'gen'}`,
      deviceId: device?.id,
      plantId: plant?.id,
      severity: telemetry.tankLevel <= 10 ? 'critical' : 'warning',
      type: 'WATER_TANK_LOW',
      title: 'Water Reservoir Low',
      message: `Irrigation tank reservoir is at ${telemetry.tankLevel}%. Refill tank to prevent pump dry-running.`,
      timestamp: now
    });
  }

  // High Temperature
  if (typeof telemetry.temperature === 'number' && telemetry.temperature > (plant?.preferredTempMax ?? 30) + 5) {
    alerts.push({
      id: `alert_temp_high_${plant?.id || 'gen'}`,
      deviceId: device?.id,
      plantId: plant?.id,
      severity: 'warning',
      type: 'TEMPERATURE_HIGH',
      title: 'High Ambient Temperature',
      message: `Ambient temperature reached ${telemetry.temperature}°C, exceeding safe upper boundary.`,
      timestamp: now
    });
  }

  return alerts;
}
