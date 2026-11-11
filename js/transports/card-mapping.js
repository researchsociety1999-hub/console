/**
 * Field mapping from the card's /api/status packets to Sentinel samples. Written from a real status
 * response (docs/CARD_STATUS_API.md). Only fields the card really sends are mapped.
 *
 * Deliberately not mapped:
 *  - name, mac, apSSID: they identify the owner's device or network, so they are not kept or shown.
 *  - rssi: it is 0 on this card (the card is the access point), so it carries no information.
 *  - batPct / vbat: the card reports -1 when the battery is not measured. Battery is mapped only when it is 0 or more.
 *  - There is no `nfc` or `ble` field in the sample on purpose: Sentinel treats a truthy `nfc` as "a tag was just read"
 *    and `ble` as a nearby device, and the status response contains neither event.
 */

const UPTIME = /^(\d+):([0-5]\d):([0-5]\d)$/;

/** Converts the card's "HH:MM:SS" uptime text into seconds, or undefined if it is not in that form. */
export function parseUptime(text) {
  const match = UPTIME.exec(String(text));
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

export const CARD_MAPPING = {
  mapPacket(packet) {
    const uptimeSeconds = parseUptime(packet.uptime);
    return {
      heapKb: packet.heap / 1024,
      minHeapKb: packet.minHeap / 1024,
      clients: packet.clients,
      channel: packet.channel,
      ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
      ...(Number.isFinite(packet.batPct) && packet.batPct >= 0 ? { batteryPct: packet.batPct } : {}),
      ...(typeof packet.nfcPresent === 'boolean' ? { nfcReaderPresent: packet.nfcPresent } : {}),
      ...(typeof packet.nfcFw === 'string' ? { nfcFirmware: packet.nfcFw } : {})
    };
  },

  // These must be present for the data to count as OK; otherwise it is shown as degraded.
  requiredFields: ['heapKb', 'minHeapKb', 'uptimeSeconds'],

  // YOUR CHOICE: the limit below is only a starting suggestion. The card was seen with about 102 KB free when
  // idle; change threshold and horizonSeconds to what matters to you.
  metrics: [
    { key: 'heapKb', label: 'Free memory', unit: ' KB', direction: 'below', threshold: 40, horizonSeconds: 600 }
  ],

  primaryMetric: { key: 'heapKb', label: 'Free memory', unit: 'KB' },

  // An alert is marked resolved after this many consecutive quiet monitoring cycles (15 s each).
  resolveAfterCycles: 3

  // No createCommandBridge: no card command has been documented or captured, so none is configured.
};

/**
 * Maps a validated card status packet into the Console / AEGIS telemetry shape.
 * Only uses fields the card actually sends. Thermal and BLE device counts stay unset
 * because /api/status does not provide them.
 */
export function mapCardPacketToConsoleSample(packet) {
  if (!packet || typeof packet !== 'object') return null;
  const mapped = CARD_MAPPING.mapPacket(packet);
  if (!mapped || typeof mapped.heapKb !== 'number') return null;

  return {
    source: 'card',
    thermal: null,
    temperatureC: null,
    heapKb: mapped.heapKb,
    minHeapKb: mapped.minHeapKb,
    clients: mapped.clients,
    channel: mapped.channel,
    uptimeSeconds: mapped.uptimeSeconds,
    batteryPct: mapped.batteryPct,
    wifi: {
      accessPoints: Number.isFinite(mapped.clients) ? mapped.clients : 0,
      channel: mapped.channel
    },
    ble: { devices: 0 },
    nfc: {
      eventsLast5Min: mapped.nfcReaderPresent ? 1 : 0,
      present: mapped.nfcReaderPresent,
      firmware: mapped.nfcFirmware
    },
    modules: [
      { id: 'nfc', status: mapped.nfcReaderPresent ? 'OK' : 'ABSENT' },
      { id: 'wifi', status: 'OK' }
    ],
    provenance: packet.provenance ?? null
  };
}
