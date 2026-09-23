/**
 * protocol — typed wire contracts for the three transport links.
 *
 *   ./daemon-server.ts        daemon ↔ Workers server WS
 *   ./dashboard-server.ts     dashboard ↔ UserSessionDO WS (+ share viewer ↔ SharedSessionDO)
 *   ./dashboard-daemon-p2p.ts dashboard ↔ daemon DataChannel
 *
 * Each exports name tuples, discriminated unions, type guards and a
 * `decode<Link><Direction>(raw)` parse-boundary function. ../ws-protocol.ts
 * keeps the pre-existing name-only aliases derived from these.
 */

export * from './envelope'
export * from './daemon-server'
export * from './dashboard-server'
export * from './dashboard-daemon-p2p'
