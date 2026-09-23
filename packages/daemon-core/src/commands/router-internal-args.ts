/**
 * Router-internal argument keys.
 *
 * `DaemonCommandRouter.execute` (router.ts `normalizeCommandArgsWithInteractionId`)
 * and `createDaemonHostRuntime.execute` (boot/host-runtime.ts) stamp
 * `_interactionId` onto EVERY command's args before the handler runs, and a few
 * handlers read it back (`low-family/session-host.ts`). That is a daemon-internal
 * convention, not part of any wire contract: the `@adhdev/mesh-shared` turn-IPC
 * request decoders (`turn-ipc.ts`, `hasOnlyKeys`) are strict on purpose, so a
 * request that reached the daemon with the router's stamp attached failed
 * `request failed decode (bad shape)` on every transport — caught live on the
 * 2026-09-25 standalone pass (`mesh_send_task` → `queue_query`), where the
 * unit tests had not, because they call the handlers directly and never cross
 * the router.
 *
 * Convention: a leading underscore marks a router-internal key. Responders
 * that decode a strict wire request strip these before decoding
 * (`stripRouterInternalArgs`); everything else keeps seeing them.
 */

export const ROUTER_INTERNAL_ARG_PREFIX = '_';

export function isRouterInternalArgKey(key: string): boolean {
    return key.startsWith(ROUTER_INTERNAL_ARG_PREFIX);
}

/** A shallow copy of `args` without the router-internal (`_`-prefixed) keys. Non-objects pass through. */
export function stripRouterInternalArgs<T = unknown>(args: T): T {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (isRouterInternalArgKey(key)) continue;
        out[key] = value;
    }
    return out as T;
}
