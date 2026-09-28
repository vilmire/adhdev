/**
 * Browser shim for the bare `crypto` specifier (copy of the web-cloud shim; web-standalone is OSS and cannot import it).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `@adhdev/daemon-core/seqscribe/transcript-keyed-folder` (and the keyed codec
 * it imports) is consumed by web-core's transcript transport
 * (`transcript-session-subscription.ts`), but
 * daemon-core is built by tsup with `platform: node` / `target: node18` and
 * `noExternal: ['seqscribe']`. Inlining seqscribe drags in its `@noble/hashes`
 * dependency, and under the Node condition that resolves to
 * `@noble/hashes/esm/cryptoNode.js`, which does a bare `import * as nc from
 * "crypto"`.
 *
 * That bare specifier is unresolvable in a browser. Listing `crypto` in
 * `build.rollupOptions.external` made Rollup emit it verbatim into the bundle,
 * so the dashboard died at load with:
 *   `Failed to resolve module specifier "crypto"`.
 *
 * ── Why a shim rather than dropping the external ──────────────────────────
 * The codec only ever hashes (SHA-256 over JCS), which is pure JS. The
 * `crypto` module is referenced solely for `randomBytes`, on a code path this
 * bundle never executes. So the import needs to *resolve*, not to work — but
 * we still map it onto Web Crypto rather than a throwing stub, so that any
 * future caller of `getRandomValues` gets the real thing instead of a crash.
 *
 * `webcrypto` is the member `cryptoNode.js` probes for; `randomBytes` is
 * deliberately absent, which makes that file fall through to `webcrypto`.
 */
const webcrypto: Crypto | undefined =
    typeof globalThis === 'object' && 'crypto' in globalThis ? globalThis.crypto : undefined

export { webcrypto }
export default { webcrypto }
