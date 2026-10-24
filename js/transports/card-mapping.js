/**
 * Field mapping from the card's validated packets to Sentinel samples.
 *
 * Stays null until it is written from EVIDENCE (captured frames, see docs/CARD_PROTOCOL.md).
 * While null, sentinel.html shows NOT CONFIGURED and cannot connect or show readings.
 *
 * Shape:
 *   {
 *     mapPacket(packet) -> sample | null,        // use only fields the card really sends; return null if unusable
 *     requiredFields: ['...'],                    // sample fields that must be present for the data to count as OK
 *     metrics: [{ key, label, unit, direction, threshold, horizonSeconds }],   // metrics to forecast (limits are yours to choose)
 *     primaryMetric: { key, label, unit },        // the big number on the main card
 *     resolveAfterCycles: 3,                      // optional: resolve an alert after this many quiet cycles
 *     createCommandBridge(transport) -> (action, alert) => Promise<{ acknowledged: boolean }>   // optional; only for documented commands
 *   }
 *
 * Privacy: any ble.id you return must already be a short, non-identifying token (for example a
 * locally hashed value), never a raw device address.
 */
export const CARD_MAPPING = null;
