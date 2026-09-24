/**
 * Mesh direct-call sites go through `router.execute(cmd, args, 'mesh')` since
 * wiring-unification B4 (they used to call `cliManager.handleCliCommand`, which
 * B3 deleted). These tests keep their existing transport stub — a
 * `handleCliCommand(cmd, args)` vi.fn on the fake cliManager — and this router
 * forwards to it, FAILING any call that is not tagged `source: 'mesh'` +
 * `{ inProcess: true }`, so
 * every existing call assertion now also proves the routing + source tag.
 *
 * The stub is resolved at CALL time, so a test that swaps
 * `components.cliManager` (or its handleCliCommand) mid-test keeps working.
 */
import { vi } from 'vitest'
import { withTurnLedger } from './mesh-turn-ledger-fixture.js'

export function meshRouterExecute(components: { cliManager?: any }) {
  return vi.fn(async (cmd: string, args: any, source?: string, opts?: { inProcess?: boolean }) => {
    if (source !== 'mesh') throw new Error(`mesh site called router.execute('${cmd}') with source '${source}', expected 'mesh'`)
    // An in-process mesh call must say so, or the router's mesh sender gate
    // (commands/mesh-sender.ts) refuses it as a relayed command with no sender.
    if (opts?.inProcess !== true) throw new Error(`mesh site called router.execute('${cmd}', …, 'mesh') without { inProcess: true }`)
    const handle = components.cliManager?.handleCliCommand
    if (typeof handle !== 'function') throw new Error(`no transport stub for router.execute('${cmd}')`)
    return handle(cmd, args)
  })
}

/** Attach (or extend) `components.router` with the mesh execute stub; returns components. */
export function withMeshRouter<T extends { cliManager?: any; router?: any }>(components: T): T {
  // A components object that had NO router before must keep behaving as if the
  // router's cache were empty: mesh code calls `router?.getCachedInlineMesh(id)`.
  const router = components.router ?? { getCachedInlineMesh: () => undefined }
  if (typeof router.execute !== 'function') router.execute = meshRouterExecute(components)
  ;(components as any).router = router
  // Production components always carry the S7 turn ledger; a claim without one
  // is refused (rc.39). A fixture that sets `turnLedger` itself (even null) keeps it.
  withTurnLedger(components as Record<string, any>)
  return components
}
