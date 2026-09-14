import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'net'
import fs from 'fs'
import path from 'path'
import Module from 'module'
import { AdhMuxControlClient } from '@adhdev/terminal-mux-control/control-socket'
import { getWorkspaceControlEndpoint } from '@adhdev/terminal-mux-control/storage'

// A control server that accepts the connection but never answers used to leave
// request() pending forever, with Ctrl-C as the CLI's only escape. The timeout
// matches the sister client in session-host-core ipc.ts.
// Bounded so a regression fails as a clear timeout rather than hanging the suite
// (the pre-fix behavior is an indefinite pending promise, which produces no output).
test('control request rejects instead of hanging against an unresponsive server', { timeout: 15_000 }, async (t) => {
  const workspaceName = `adhmux-timeout-${process.pid}`
  const endpoint = getWorkspaceControlEndpoint(workspaceName)
  fs.mkdirSync(path.dirname(endpoint.path), { recursive: true })
  try {
    fs.unlinkSync(endpoint.path)
  } catch {
    // noop
  }

  const server = net.createServer(() => {
    // Accept and swallow: never write a response envelope.
  })
  await new Promise<void>((resolve) => server.listen(endpoint.path, () => resolve()))

  const client = new AdhMuxControlClient(workspaceName)
  t.after(async () => {
    await client.close().catch(() => {})
    server.close()
    try {
      fs.unlinkSync(endpoint.path)
    } catch {
      // noop
    }
  })

  // Drive the real timer rather than waiting out the full 30s budget.
  const originalSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = ((fn: (...a: any[]) => void, ms?: number, ...rest: any[]) =>
    originalSetTimeout(fn, ms === 30_000 ? 50 : ms, ...rest)) as typeof globalThis.setTimeout
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  await assert.rejects(
    client.request({ type: 'list_panes' }),
    /timed out after 30s \(list_panes\)/,
    'request must reject on timeout rather than stay pending',
  )

  // The waiter must be cleaned up, not leaked for a late response to resolve.
  assert.equal((client as any).waiters.size, 0, 'timed-out waiter leaked')
})

// The barrel re-exports the ghostty surface. An eager top-level require made a
// type-only `import { type MuxWorkspaceState } from '@adhdev/terminal-mux-core'`
// (render.ts, commands-pane.ts) fatal on any platform-arch with no committed
// prebuilt — darwin-x64, linux-arm64 — taking down the whole adhmux CLI.
test('terminal-mux-core barrel imports cleanly when the native binding is unavailable', async () => {
  const realResolve = (Module as any)._resolveFilename
  ;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
    if (request === '@adhdev/ghostty-vt-node') {
      throw new Error(
        'Unable to load @adhdev/ghostty-vt-node native binding for running triplet ' +
          '"darwin-x64-node127". Available prebuilt triplets: [none].',
      )
    }
    return realResolve.call(this, request, ...rest)
  }

  try {
    // Bust the module cache so the barrel is evaluated under the failing resolver.
    const barrelPath = require.resolve('@adhdev/terminal-mux-core')
    delete require.cache[barrelPath]

    const mod = await import('@adhdev/terminal-mux-core')

    // Barrel contract: consumers still import the same symbols.
    assert.equal(typeof mod.GhosttyTerminalSurface, 'function', 'class export must survive')
    for (const symbol of [
      'SessionHostMuxClient',
      'createMuxWorkspace',
      'splitMuxPane',
      'resolveMuxOpenRuntimeRecord',
      'serializeWorkspace',
    ]) {
      assert.ok(symbol in mod, `barrel must still export ${symbol}`)
    }
  } finally {
    ;(Module as any)._resolveFilename = realResolve
  }
})
