import { describe, expect, it } from 'vitest'
import type * as http from 'http'
import { handleCliSSE } from '../../src/daemon/dev-cli-debug.js'
import type { DevServerContext } from '../../src/daemon/dev-server-types.js'

// Audit #15 (IPC load audit, 2026-09-23): handleCliSSE registered a new
// `instanceManager.onEvent` listener on every 0→1 SSE-client transition and
// never removed it. ProviderInstanceManager.onEvent has no unsubscribe, so a
// daemon whose dev SSE endpoint saw K such transitions (client connects,
// disconnects, another connects) accumulated K permanent listeners — every
// subsequent provider event then fanned out K times (K× duplicate work, K×
// duplicate frames to any client still connected). Pins the fix: at most ONE
// listener is ever attached per ProviderInstanceManager instance, regardless
// of how many connect/disconnect cycles handleCliSSE sees.

function fakeResponse(): http.ServerResponse & { writes: string[] } {
  const writes: string[] = []
  const closeHandlers: Array<() => void> = []
  return {
    writes,
    writeHead: () => {},
    write: (chunk: string) => { writes.push(chunk); return true },
    // handleCliSSE reads close handlers off the REQUEST, not the response —
    // see the buildCtx/req fake below.
  } as any
}

function fakeRequest(): http.IncomingMessage & { emitClose: () => void } {
  let closeHandler: (() => void) | null = null
  return {
    on: (event: string, handler: () => void) => {
      if (event === 'close') closeHandler = handler
    },
    emitClose: () => { closeHandler?.() },
  } as any
}

function buildCtx(onEventListeners: Array<(event: any) => void>, cliSSEClients: http.ServerResponse[]): DevServerContext {
  const instanceManager: any = {
    onEvent: (listener: (event: any) => void) => { onEventListeners.push(listener) },
    collectAllStates: () => [],
  }
  return {
    providerLoader: {} as any,
    cdpManagers: new Map(),
    instanceManager,
    cliManager: null,
    getCdp: () => null,
    json: () => {},
    readBody: async () => ({}),
    log: () => {},
    autoImplSSEClients: [],
    sendAutoImplSSE: () => {},
    autoImplStatus: { running: false, type: null, progress: [] },
    autoImplProcess: null,
    sendCliSSE: (data: any) => {
      const msg = `data: ${JSON.stringify(data)}\n\n`
      for (const client of cliSSEClients) {
        (client as any).write(msg)
      }
    },
    handleRunScript: async () => {},
    findProviderDir: () => null,
    getLatestScriptVersionDir: () => null,
  }
}

describe('handleCliSSE listener registration (audit #15)', () => {
  it('registers exactly one instanceManager.onEvent listener across multiple 0→1 client transitions', () => {
    const onEventListeners: Array<(event: any) => void> = []
    const cliSSEClients: http.ServerResponse[] = []
    const ctx = buildCtx(onEventListeners, cliSSEClients)

    // First client connects (0→1 transition #1).
    const req1 = fakeRequest()
    const res1 = fakeResponse()
    handleCliSSE(ctx, cliSSEClients, req1 as any, res1 as any)
    expect(onEventListeners.length).toBe(1)

    // First client disconnects — cliSSEClients drops back to 0.
    req1.emitClose()
    expect(cliSSEClients.length).toBe(0)

    // Second client connects (0→1 transition #2 — the leak trigger).
    const req2 = fakeRequest()
    const res2 = fakeResponse()
    handleCliSSE(ctx, cliSSEClients, req2 as any, res2 as any)
    expect(onEventListeners.length).toBe(1)

    // A third connect/disconnect cycle must still not add a second listener.
    req2.emitClose()
    const req3 = fakeRequest()
    const res3 = fakeResponse()
    handleCliSSE(ctx, cliSSEClients, req3 as any, res3 as any)
    expect(onEventListeners.length).toBe(1)
  })

  it('a provider event fans out exactly once per connected client, not once per historical transition', () => {
    const onEventListeners: Array<(event: any) => void> = []
    const cliSSEClients: http.ServerResponse[] = []
    const ctx = buildCtx(onEventListeners, cliSSEClients)

    // Three connect/disconnect cycles before the client that stays connected.
    for (let i = 0; i < 3; i++) {
      const req = fakeRequest()
      const res = fakeResponse()
      handleCliSSE(ctx, cliSSEClients, req as any, res as any)
      req.emitClose()
    }

    const req = fakeRequest()
    const res = fakeResponse() as http.ServerResponse & { writes: string[] }
    handleCliSSE(ctx, cliSSEClients, req as any, res as any)

    // Simulate a provider event firing through the (single) registered listener.
    expect(onEventListeners.length).toBe(1)
    onEventListeners[0]({ event: 'status_change', providerType: 'claude-cli' })

    // The leak would have made this listener count > 1, so this same simulated
    // fire would need to happen once per listener in a real daemon — here we
    // directly assert the listener count stays at 1, which is the root cause
    // audit #15 flags (K listeners => K writes per client per event).
    const statusChangeWrites = res.writes.filter((w) => w.includes('status_change'))
    expect(statusChangeWrites.length).toBe(1)
  })

  it('two independent instanceManager instances each get their own listener (no cross-daemon suppression)', () => {
    const listenersA: Array<(event: any) => void> = []
    const listenersB: Array<(event: any) => void> = []
    const clientsA: http.ServerResponse[] = []
    const clientsB: http.ServerResponse[] = []
    const ctxA = buildCtx(listenersA, clientsA)
    const ctxB = buildCtx(listenersB, clientsB)

    handleCliSSE(ctxA, clientsA, fakeRequest() as any, fakeResponse() as any)
    handleCliSSE(ctxB, clientsB, fakeRequest() as any, fakeResponse() as any)

    expect(listenersA.length).toBe(1)
    expect(listenersB.length).toBe(1)
  })
})
