/**
 * DataFirewall - Local Packet Validation & Threat Assessment Engine
 */

export class DataFirewall {
  constructor(config = {}) {
    this.rules = Array.isArray(config.rules) ? config.rules : [];
    this.minTrustScore = Number.isFinite(config.minTrustScore)
      ? config.minTrustScore
      : 50;
  }

  evaluate(packet) {
    return runDataFirewall(packet, this.rules, this.minTrustScore);
  }
}

/**
 * Validates the minimum shape expected of a locally processed module packet.
 */
export function validateModulePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return false;
  }

  return Boolean(packet.id || packet.type || packet.payload);
}

/**
 * Computes a bounded local trust score from available telemetry indicators.
 */
export function computeTrustScore(telemetry = {}) {
  const source = telemetry && typeof telemetry === 'object' ? telemetry : {};
  let score = 100;

  if (source.anomalyDetected) score -= 30;
  if (source.unauthorizedBle) score -= 20;
  if (source.pinTampered) score -= 25;

  return Math.max(0, score);
}

/**
 * Applies the local validation and trust policy without external dependencies.
 */
export function runDataFirewall(payload, rules = [], minTrustScore = 50) {
  const trustScore = computeTrustScore(payload);
  const isValid = validateModulePacket(payload);
  const activeRules = Array.isArray(rules) ? rules : [];

  const ruleResults = activeRules.map((rule) => {
    try {
      if (typeof rule === 'function') {
        return rule(payload, { trustScore, isValid }) !== false;
      }

      if (rule && typeof rule.evaluate === 'function') {
        return rule.evaluate(payload, { trustScore, isValid }) !== false;
      }

      return true;
    } catch {
      return false;
    }
  });

  const rulesPassed = ruleResults.every(Boolean);
  const threshold = Number.isFinite(minTrustScore) ? minTrustScore : 50;

  return {
    allowed: isValid && trustScore >= threshold && rulesPassed,
    trustScore,
    timestamp: Date.now()
  };
}
