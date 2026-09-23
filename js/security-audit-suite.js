export class NFCSecurityAuditor {
  classify(metadata = {}) {
    const input = typeof metadata === 'string' ? metadata : `${metadata.technology || ''} ${metadata.sak || ''} ${metadata.atqa || ''}`;
    const normalized = input.toLowerCase();
    if (/desfire\s*(ev3|ev2)|mifare plus|fido/.test(normalized)) return { classification: 'MODERN', risk: 'LOW', finding: 'Modern credential technology indicated. Maintain key-management and lifecycle review.', readOnly: true };
    if (/mifare classic|classic 1k|classic 4k|125\s*khz|prox/.test(normalized)) return { classification: 'LEGACY', risk: 'ELEVATED', finding: 'Legacy technology detected; recommend upgrading to DESFire EV3 or another modern, managed credential standard.', readOnly: true };
    return { classification: 'UNKNOWN', risk: 'REVIEW', finding: 'Technology metadata is insufficient for classification. Record the reader-provided standard and review offline.', readOnly: true };
  }
}

export class TSCMThermalScanner {
  constructor({ threshold = 2.5 } = {}) { this.threshold = threshold; this.baseline = null; }

  calibrate(samples = []) {
    const valid = samples.map(Number).filter(Number.isFinite);
    if (!valid.length) throw new Error('Thermal baseline requires numeric sensor samples.');
    this.baseline = valid.reduce((sum, value) => sum + value, 0) / valid.length;
    return this.baseline;
  }

  scan(grid = [], threshold = this.threshold) {
    if (!Number.isFinite(this.baseline)) throw new Error('Calibrate ambient baseline before scanning.');
    const values = grid.map(Number).map((value) => Number.isFinite(value) ? value : this.baseline);
    const anomalies = values.map((value, index) => ({ index, value, delta: value - this.baseline })).filter((item) => item.delta > Number(threshold));
    return { baseline: this.baseline, threshold: Number(threshold), values, anomalies, status: anomalies.length ? 'ANOMALIES_DETECTED' : 'NORMAL' };
  }

  render(canvas, result, columns = 8) {
    if (!canvas?.getContext) return;
    const ctx = canvas.getContext('2d');
    const values = result?.values || [];
    const rows = Math.max(1, Math.ceil(values.length / columns));
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    values.forEach((value, index) => {
      const ratio = Math.max(0, Math.min(1, (value - result.baseline + 2) / 8));
      const red = Math.round(40 + ratio * 215);
      const blue = Math.round(220 - ratio * 200);
      ctx.fillStyle = `rgb(${red}, 70, ${blue})`;
      ctx.fillRect((index % columns) * cellWidth, Math.floor(index / columns) * cellHeight, cellWidth, cellHeight);
    });
  }
}

export class GPIOSecurityMonitor {
  constructor({ dataFirewall = null } = {}) {
    this.dataFirewall = dataFirewall;
    this.lastState = null;
    this.activity = { wiegandD0: 0, wiegandD1: 0 };
  }

  async update(snapshot = {}) {
    const state = {
      doorContact: Boolean(snapshot.doorContact),
      pirMotion: Boolean(snapshot.pirMotion),
      vibrationTamper: Boolean(snapshot.vibrationTamper),
      wiegandD0Activity: Math.max(0, Number(snapshot.wiegandD0Activity) || 0),
      wiegandD1Activity: Math.max(0, Number(snapshot.wiegandD1Activity) || 0)
    };
    this.activity.wiegandD0 += state.wiegandD0Activity;
    this.activity.wiegandD1 += state.wiegandD1Activity;
    const changed = this.lastState && ['doorContact', 'pirMotion', 'vibrationTamper'].some((key) => this.lastState[key] !== state[key]);
    if ((state.vibrationTamper || changed) && this.dataFirewall?.authorized) await this.dataFirewall.logEvent('TAMPER_ALERT', { doorContact: state.doorContact, pirMotion: state.pirMotion, vibrationTamper: state.vibrationTamper, wiegandActivityOnly: { d0: state.wiegandD0Activity, d1: state.wiegandD1Activity } });
    this.lastState = state;
    return { ...state, activity: { ...this.activity }, payloadCaptured: false };
  }
}

export class OfflineAssetAuditor {
  assess(assets = []) {
    if (!Array.isArray(assets)) throw new Error('Offline asset inventory must be a JSON array.');
    const findings = assets.map((asset, index) => {
      const name = String(asset?.name || `Asset-${index + 1}`).slice(0, 128);
      const issues = [];
      if (asset?.credentialRotationNeeded) issues.push('Credential rotation is marked as required.');
      if (asset?.firmwareReviewNeeded) issues.push('Firmware review is marked as required.');
      if (asset?.segmentationReviewNeeded) issues.push('Network segmentation review is marked as required.');
      return { name, posture: issues.length ? 'REVIEW_REQUIRED' : 'NO_MANUAL_FINDING', issues };
    });
    return { assessedOffline: true, assetCount: findings.length, findings, reviewRequired: findings.filter((item) => item.posture === 'REVIEW_REQUIRED').length };
  }
}
