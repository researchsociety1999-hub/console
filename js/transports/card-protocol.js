/**
 * Card protocol descriptor.
 *
 * Stays null until it is filled in from EVIDENCE about the real card (captured panel traffic,
 * firmware source, or vendor documentation). While null, the dashboard cannot connect and shows
 * no readings. Do not guess values. See docs/CARD_PROTOCOL.md.
 *
 * Wi-Fi shape (all fields required unless marked optional):
 *   {
 *     kind: 'wifi',
 *     baseUrl: string,                       // address of the card's panel
 *     identity: { path, responseType, parse(body) -> { id, name } | null },
 *     telemetry: {
 *       mode: 'poll' | 'websocket',
 *       path: string,
 *       responseType: 'json' | 'text' | 'arrayBuffer',   // poll mode only
 *       parse(rawBody) -> packet | null,
 *       validate(packet) -> packet,          // must throw on bad or incomplete data
 *       staleAfterMs: number,                // app policy: how old a reading may be
 *       disconnectAfterFailures?: number     // poll mode, optional (default 3)
 *     },
 *     allowCommands?: boolean,               // default off
 *     commands?: { [name]: { method, path, responseType, headers?, buildBody(params), parseAck(body) -> { acknowledged: true } } }
 *   }
 *
 * BLE shape:
 *   {
 *     kind: 'ble',
 *     filters: [{ services?, name?, namePrefix? }],   // at least one; wildcard selection is refused
 *     optionalServices?: string[],
 *     verifyDevice({ device, server }) -> Promise<{ id, name } | null>,
 *     telemetry: { mode: 'notify' | 'read', service, characteristic, parse(dataView) -> packet | null,
 *                  validate(packet) -> packet, staleAfterMs }
 *   }
 */
export const CARD_PROTOCOL = null;
