import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  ADHDEV_DEV_SERVER_AUTH_FILE_ENV,
  ADHDEV_DEV_SERVER_TOKEN_HEADER,
  DevServer,
  buildDevServerAuthHeaders,
  devServerAuthFilePath,
  readDevServerAuthToken,
  requestDevServerLoopback,
} from '../../src/daemon/dev-server.js'
import { ProviderLoader } from '../../src/providers/provider-loader.js'
import { validateCliProviderManifest } from '../../src/providers/sdk/v1/index.js'
import { validateFsmSpec } from '../../src/providers/spec/fsm-loader.js'

// These tests drive the REAL `/api/scaffold` HTTP route (handleScaffold ->
// genScaffoldFiles / buildCliProviderV1Scaffold)
// exactly as the online-first path of `adhdev provider
// create` (packages/daemon-cloud/src/cli/provider-commands.ts) call it, then
// run the output through the same daemon-core validators the daemon uses at
// install/load time and at launch time — a green run here means the
// DevServer scaffold produces something that can actually launch, not just
// something that looks plausible.
//
// Regression context: category=cli previously wrote a legacy provider.json +
// scripts/0.1/*.js layout. That engine was deleted
// (providers/spec/route.ts formatNoResolvableSpecError) — a CLI provider
// with no resolvable FSM spec fails to launch. This test breaks-once against
// that regression.

async function startServer(userDir: string): Promise<{ server: DevServer; port: number; token: string }> {
  const loader = new ProviderLoader({ userDir, disableUpstream: true })
  loader.loadAll()
  const server = new DevServer({
    providerLoader: loader,
    cdpManagers: new Map(),
    logFn: () => {},
    configDir: userDir,
  })
  // DevServer.start(port) binds to a fixed port (there is no "pick any free
  // port" mode) and resolves even on EADDRINUSE (treated as non-fatal —
  // see dev-server.ts start()), so pick a high, unlikely-to-collide port
  // per test run instead of hardcoding DEV_SERVER_PORT (19280), which a
  // real running daemon may already hold.
  const port = 20000 + Math.floor(Math.random() * 10000)
  await server.start(port)
  return { server, port, token: server.getAuthToken() || '' }
}

function postScaffold(
  port: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/scaffold',
        method: 'POST',
        headers: buildDevServerAuthHeaders({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...extraHeaders,
        }, port),
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(data), headers: res.headers })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function rawDevRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: Record<string, unknown> },
): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : null, headers: res.headers })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

describe('DevServer /api/scaffold', () => {
  let tempRoot: string | null = null
  let server: DevServer | null = null

  afterEach(() => {
    server?.stop()
    server = null
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
      tempRoot = null
    }
  })

  it('category=cli writes provider.v1.json + specs/1.0.json that pass validateCliProviderManifest and validateFsmSpec (not the legacy provider.json + scripts layout)', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-scaffold-'))
    const started = await startServer(tempRoot)
    server = started.server

    const res = await postScaffold(started.port, { type: 'my-cli', name: 'My CLI', category: 'cli' })
    expect(res.status).toBe(201)
    expect(res.json.files).toEqual(['provider.v1.json', path.join('specs', '1.0.json')])

    const targetDir = res.json.path as string
    const manifestPath = path.join(targetDir, 'provider.v1.json')
    const specPath = path.join(targetDir, 'specs', '1.0.json')
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(specPath)).toBe(true)
    // The legacy layout must NOT be produced for cli — it can never launch.
    expect(existsSync(path.join(targetDir, 'provider.json'))).toBe(false)
    expect(existsSync(path.join(targetDir, 'scripts'))).toBe(false)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const manifestResult = validateCliProviderManifest(manifest)
    expect(manifestResult.ok, JSON.stringify((manifestResult as any).issues)).toBe(true)

    const spec = JSON.parse(readFileSync(specPath, 'utf-8'))
    const specErrors = validateFsmSpec(spec as any)
    expect(specErrors).toEqual([])
  })

  it('category=ide still produces the legacy provider.json + scripts/<version>/*.js layout (engine still live)', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-scaffold-'))
    const started = await startServer(tempRoot)
    server = started.server

    const res = await postScaffold(started.port, { type: 'my-ide', name: 'My IDE', category: 'ide' })
    expect(res.status).toBe(201)

    const targetDir = res.json.path as string
    expect(existsSync(path.join(targetDir, 'provider.json'))).toBe(true)
    // No v1 manifest for legacy categories.
    expect(existsSync(path.join(targetDir, 'provider.v1.json'))).toBe(false)
    expect(res.json.files).toContain('provider.json')
    expect(res.json.files.some((f: string) => f.includes('scripts.js'))).toBe(true)

    const manifest = JSON.parse(readFileSync(path.join(targetDir, 'provider.json'), 'utf-8'))
    expect(manifest.category).toBe('ide')
  })

  it('rejects a second scaffold when the manifest the category would produce already exists (409)', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-scaffold-'))
    const started = await startServer(tempRoot)
    server = started.server

    const first = await postScaffold(started.port, { type: 'dup-cli', name: 'Dup CLI', category: 'cli' })
    expect(first.status).toBe(201)

    const second = await postScaffold(started.port, { type: 'dup-cli', name: 'Dup CLI', category: 'cli' })
    expect(second.status).toBe(409)
  })

  it('enforces Host/Origin allow-list, drops wildcard CORS, and requires per-boot token for provider file writes and reload', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-ingress-'))
    const providerDir = path.join(tempRoot, 'ide', 'demo-ide')
    mkdirSync(providerDir, { recursive: true })
    writeFileSync(
      path.join(providerDir, 'provider.json'),
      JSON.stringify({ type: 'demo-ide', name: 'Demo IDE', category: 'ide', cdpPorts: [9222, 9223] }, null, 2),
      'utf-8',
    )
    writeFileSync(path.join(providerDir, 'scripts.js'), 'module.exports = {};\n', 'utf-8')

    const started = await startServer(tempRoot)
    server = started.server
    expect(started.token).toMatch(/^add_/)

    // 1. Untrusted Host (DNS rebinding) is rejected with 403 before auth or route handling
    const rebindRes = await rawDevRequest(started.port, {
      method: 'POST',
      path: '/api/providers/demo-ide/file',
      headers: {
        Host: `rebind.example:${started.port}`,
        Origin: `http://rebind.example:${started.port}`,
        [ADHDEV_DEV_SERVER_TOKEN_HEADER]: started.token,
      },
      body: { path: 'scripts.js', content: 'module.exports = { pwned: true };' },
    })
    expect(rebindRes.status).toBe(403)
    expect(rebindRes.headers['access-control-allow-origin']).toBeUndefined()

    // 2. Cross-origin and cross-port loopback Origin requests are rejected with 403 and no wildcard CORS
    for (const badOrigin of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8080']) {
      const crossOriginRes = await rawDevRequest(started.port, {
        method: 'POST',
        path: '/api/providers/demo-ide/file',
        headers: {
          Host: `127.0.0.1:${started.port}`,
          Origin: badOrigin,
          [ADHDEV_DEV_SERVER_TOKEN_HEADER]: started.token,
        },
        body: { path: 'scripts.js', content: 'module.exports = { pwned: true };' },
      })
      expect(crossOriginRes.status, badOrigin).toBe(403)
      expect(crossOriginRes.headers['access-control-allow-origin']).toBeUndefined()
    }

    // 3. Unauthenticated loopback requests (missing or wrong token) to status, file write, save, and reload are rejected with 401
    for (const endpoint of [
      { method: 'GET', path: '/api/status' },
      { method: 'POST', path: '/api/providers/demo-ide/file', body: { path: 'scripts.js', content: 'x' } },
      { method: 'POST', path: '/api/providers/demo-ide/save', body: { source: 'x' } },
      { method: 'POST', path: '/api/providers/reload', body: {} },
    ]) {
      const noTokenRes = await rawDevRequest(started.port, endpoint)
      expect(noTokenRes.status, `${endpoint.method} ${endpoint.path} no token`).toBe(401)
      expect(noTokenRes.headers['access-control-allow-origin']).toBeUndefined()

      const badTokenRes = await rawDevRequest(started.port, {
        ...endpoint,
        headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: 'add_wrong_token' },
      })
      expect(badTokenRes.status, `${endpoint.method} ${endpoint.path} bad token`).toBe(401)
    }
    expect(readFileSync(path.join(providerDir, 'scripts.js'), 'utf-8')).toBe('module.exports = {};\n')

    // 4. Query-string ?token= is rejected (INGRESS-04: header-only auth)
    const queryTokenRes = await rawDevRequest(started.port, {
      method: 'GET',
      path: `/api/status?token=${encodeURIComponent(started.token)}`,
    })
    expect(queryTokenRes.status).toBe(401)

    // 5. Legitimate local CLI / same-origin requests with valid token header succeed
    const authedWrite = await rawDevRequest(started.port, {
      method: 'POST',
      path: '/api/providers/demo-ide/file',
      headers: {
        Host: `127.0.0.1:${started.port}`,
        Origin: `http://127.0.0.1:${started.port}`,
        [ADHDEV_DEV_SERVER_TOKEN_HEADER]: started.token,
      },
      body: { path: 'scripts.js', content: 'module.exports = { updated: true };\n' },
    })
    expect(authedWrite.status).toBe(200)
    expect(authedWrite.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${started.port}`)
    expect(readFileSync(path.join(providerDir, 'scripts.js'), 'utf-8')).toBe('module.exports = { updated: true };\n')

    // 6. INGRESS-01: A second DevServer start on the same occupied port (EADDRINUSE) does not
    // overwrite the incumbent server's published token file or break its clients; stop() cleans up
    // only the owned credential, and restart publishes a fresh working credential.
    const authFile = devServerAuthFilePath(tempRoot, started.port)
    expect(existsSync(authFile)).toBe(true)
    expect(readFileSync(authFile, 'utf-8').trim()).toBe(started.token)

    const duplicateLoader = new ProviderLoader({ userDir: tempRoot, disableUpstream: true })
    duplicateLoader.loadAll()
    const duplicateServer = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    await duplicateServer.start(started.port)
    expect(duplicateServer.getAuthToken()).toBeNull()
    expect(readFileSync(authFile, 'utf-8').trim()).toBe(started.token)
    expect(readDevServerAuthToken(started.port, tempRoot)).toBe(started.token)

    // Stopping the non-listening duplicate does not delete the incumbent's auth file
    duplicateServer.stop()
    expect(existsSync(authFile)).toBe(true)
    expect(readFileSync(authFile, 'utf-8').trim()).toBe(started.token)

    // INGRESS-09: After an EADDRINUSE skip (without calling stop() in between), startPromise is cleared
    // so the same DevServer instance can immediately retry on an available port and bind cleanly.
    const retryAfterCollisionServer = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    await retryAfterCollisionServer.start(started.port)
    expect(retryAfterCollisionServer.getAuthToken()).toBeNull()
    const retryFreePort = 20000 + Math.floor(Math.random() * 10000)
    await retryAfterCollisionServer.start(retryFreePort)
    const retryFreeToken = retryAfterCollisionServer.getAuthToken() || ''
    expect(retryFreeToken).toMatch(/^add_/)
    const statusOnRetryFree = await rawDevRequest(retryFreePort, {
      method: 'GET',
      path: '/api/status',
      headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: retryFreeToken },
    })
    expect(statusOnRetryFree.status).toBe(200)
    retryAfterCollisionServer.stop()
    expect(existsSync(devServerAuthFilePath(tempRoot, retryFreePort))).toBe(false)

    // Restore incumbent env pointer after retryAfterCollisionServer.stop()
    process.env[ADHDEV_DEV_SERVER_AUTH_FILE_ENV] = authFile

    const statusAfterDuplicate = await rawDevRequest(started.port, {
      method: 'GET',
      path: '/api/status',
      headers: buildDevServerAuthHeaders({}, started.port, tempRoot) as Record<string, string>,
    })
    expect(statusAfterDuplicate.status).toBe(200)

    // Stopping the incumbent cleans up its published auth file and env var
    server.stop()
    server = null
    expect(existsSync(authFile)).toBe(false)
    expect(process.env[ADHDEV_DEV_SERVER_AUTH_FILE_ENV]).toBeUndefined()

    // Restarting on a fresh port publishes a new working credential
    const restartedPort = 20000 + Math.floor(Math.random() * 10000)
    const restartedAuthFile = devServerAuthFilePath(tempRoot, restartedPort)
    const restarted = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    await restarted.start(restartedPort)
    server = restarted
    const newToken = restarted.getAuthToken() || ''
    expect(newToken).toMatch(/^add_/)
    expect(newToken).not.toBe(started.token)
    expect(readFileSync(restartedAuthFile, 'utf-8').trim()).toBe(newToken)

    const statusWithOldToken = await rawDevRequest(restartedPort, {
      method: 'GET',
      path: '/api/status',
      headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: started.token },
    })
    expect(statusWithOldToken.status).toBe(401)

    const statusWithNewToken = await rawDevRequest(restartedPort, {
      method: 'GET',
      path: '/api/status',
      headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: newToken },
    })
    expect(statusWithNewToken.status).toBe(200)

    // Fail-closed publication test: if the run directory is not writable when a fresh server starts,
    // start() rejects and closes the listener rather than running unauthenticated or with an unpublished token.
    // INGRESS-09: Once the permissions are restored, the same DevServer instance can retry start() without stop().
    restarted.stop()
    server = null
    const runDir = path.join(tempRoot, 'run')
    const failClosedServer = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    const failPort = 20000 + Math.floor(Math.random() * 10000)
    chmodSync(runDir, 0o500)
    try {
      await expect(failClosedServer.start(failPort)).rejects.toThrow(/Failed to publish DevServer auth credential/)
      expect(failClosedServer.getAuthToken()).toBeNull()
    } finally {
      chmodSync(runDir, 0o700)
    }
    await failClosedServer.start(failPort)
    expect(failClosedServer.getAuthToken()).toMatch(/^add_/)
    failClosedServer.stop()

    // INGRESS-09: Calling stop() while start() is still pending (before the listen callback completes)
    // settles the pending start promise instead of hanging, closes the pending server, and allows a clean restart.
    const stopDuringBindServer = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    const pendingBindPort = 20000 + Math.floor(Math.random() * 10000)
    const pendingStart = stopDuringBindServer.start(pendingBindPort)
    stopDuringBindServer.stop()
    await pendingStart
    expect(stopDuringBindServer.getAuthToken()).toBeNull()
    expect(existsSync(devServerAuthFilePath(tempRoot, pendingBindPort))).toBe(false)

    await stopDuringBindServer.start(pendingBindPort)
    const restartedAfterCancelToken = stopDuringBindServer.getAuthToken() || ''
    expect(restartedAfterCancelToken).toMatch(/^add_/)
    const statusAfterCancelRestart = await rawDevRequest(pendingBindPort, {
      method: 'GET',
      path: '/api/status',
      headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: restartedAfterCancelToken },
    })
    expect(statusAfterCancelRestart.status).toBe(200)
    stopDuringBindServer.stop()

    // INGRESS-05: Overlapping start() calls on the SAME DevServer instance must not bind a second listener,
    // overwrite the first listener/token, or leave an open listener serving protected routes without auth after stop().
    const singleInstance = new DevServer({
      providerLoader: duplicateLoader,
      cdpManagers: new Map(),
      logFn: () => {},
      configDir: tempRoot,
    })
    server = singleInstance
    const overlapPortA = 20000 + Math.floor(Math.random() * 10000)
    const overlapPortB = overlapPortA + 1
    await Promise.all([singleInstance.start(overlapPortA), singleInstance.start(overlapPortB)])
    const activeToken = singleInstance.getAuthToken() || ''
    expect(activeToken).toMatch(/^add_/)
    expect(existsSync(devServerAuthFilePath(tempRoot, overlapPortA))).toBe(true)
    expect(existsSync(devServerAuthFilePath(tempRoot, overlapPortB))).toBe(false)

    // Port A is authenticated; Port B was never bound
    const resOnA = await rawDevRequest(overlapPortA, {
      method: 'GET',
      path: '/api/status',
      headers: { [ADHDEV_DEV_SERVER_TOKEN_HEADER]: activeToken },
    })
    expect(resOnA.status).toBe(200)
    await expect(
      rawDevRequest(overlapPortB, { method: 'GET', path: '/api/status' }),
    ).rejects.toThrow()

    // Even if authToken is cleared without explicitAuthToken === null, requests fail closed (401)
    ;(singleInstance as any).authToken = null
    const resWithNullToken = await rawDevRequest(overlapPortA, {
      method: 'GET',
      path: '/api/status',
    })
    expect(resWithNullToken.status).toBe(401)
    ;(singleInstance as any).authToken = activeToken

    // After stop(), Port A is closed and no listener remains open
    singleInstance.stop()
    server = null
    await expect(
      rawDevRequest(overlapPortA, { method: 'GET', path: '/api/status' }),
    ).rejects.toThrow()
  })

  it('INGRESS-02 / INGRESS-06 / INGRESS-08: verify_provider.py and verify_cli_provider.py authenticate against loopback DevServer, verify screenshot output, and refuse non-loopback or redirect credential exfiltration', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-py-verify-'))
    const loader = new ProviderLoader({ userDir: tempRoot, disableUpstream: true })
    loader.loadAll()
    const fakeWebp = Buffer.from('RIFF\x14\x00\x00\x00WEBPVP8 \x08\x00\x00\x00fakewebp', 'binary')
    let screenshotCaptures = 0
    const fakeCdpManager: any = {
      isConnected: true,
      send: async () => ({ cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } }),
      captureScreenshot: async () => {
        screenshotCaptures += 1
        return fakeWebp
      },
    }
    const cdpManagers = new Map<string, any>([['demo-ide', fakeCdpManager]])
    const devSrv = new DevServer({
      providerLoader: loader,
      cdpManagers,
      logFn: () => {},
      configDir: tempRoot,
    })
    const port = 20000 + Math.floor(Math.random() * 10000)
    await devSrv.start(port)
    server = devSrv
    const token = devSrv.getAuthToken() || ''

    const repoRoot = path.resolve(__dirname, '../../../../..')
    const scriptsDir = path.join(repoRoot, 'scripts')
    if (!existsSync(path.join(scriptsDir, 'verify_provider.py'))) {
      return
    }

    // Stand up a local redirector server on another port to verify redirects are refused and never leak headers
    let redirectTargetHits = 0
    let redirectTargetLeakedToken: string | undefined
    const redirectServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/target')) {
        redirectTargetHits += 1
        redirectTargetLeakedToken = req.headers[ADHDEV_DEV_SERVER_TOKEN_HEADER] as string | undefined
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ leaked: true }))
        return
      }
      res.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/target` })
      res.end()
    })
    const redirectPort = await new Promise<number>((resolve) => {
      redirectServer.listen(0, '127.0.0.1', () => {
        const addr = redirectServer.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    writeFileSync(devServerAuthFilePath(tempRoot, redirectPort), token, { mode: 0o600 })

    // Stand up a local proxy trap server to verify HTTP_PROXY / http_proxy environment settings are ignored
    let proxyTrapHits = 0
    let proxyTrapLeakedToken: string | undefined
    const proxyTrapServer = http.createServer((req, res) => {
      proxyTrapHits += 1
      proxyTrapLeakedToken = req.headers[ADHDEV_DEV_SERVER_TOKEN_HEADER] as string | undefined
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ proxied: true }))
    })
    const proxyTrapPort = await new Promise<number>((resolve) => {
      proxyTrapServer.listen(0, '127.0.0.1', () => {
        const addr = proxyTrapServer.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    const screenshotLabel = `ing08_${process.pid}_${Date.now()}`
    const expectedScreenshotFile = `/tmp/screenshot_demo-ide_${screenshotLabel}.webp`

    try {
      // INGRESS-10: Node requestDevServerLoopback attaches the per-boot token over a direct loopback
      // socket (agent: false, bypassing global fetch/proxy dispatchers) and rejects 3xx redirects
      // without following Location or leaking x-adhdev-dev-token to the redirect target.
      const directStatus = await requestDevServerLoopback({
        port,
        path: '/api/status',
        method: 'GET',
        configDir: tempRoot,
      })
      expect(directStatus.ok).toBe(true)
      expect(directStatus.status).toBe(200)
      expect(directStatus.data?.devMode).toBe(true)

      await expect(
        requestDevServerLoopback({
          port: redirectPort,
          path: '/api/status',
          method: 'GET',
          configDir: tempRoot,
        }),
      ).rejects.toThrow(/Redirects are disallowed for DevServer requests \(HTTP 302\)/)
      expect(redirectTargetHits).toBe(0)
      expect(redirectTargetLeakedToken).toBeUndefined()

      await expect(
        requestDevServerLoopback({
          port: 0,
          path: '/api/status',
        }),
      ).rejects.toThrow(/Invalid DevServer port: 0/)

      await expect(
        requestDevServerLoopback({
          port,
          path: '//evil.example/api/status',
        }),
      ).rejects.toThrow(/Invalid DevServer path/)

      const pySnippet = [
        'import sys, os, json',
        `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
        'import verify_provider as vp',
        'import verify_cli_provider as vcp',
        // INGRESS-06: Even when HTTP_PROXY / http_proxy is set and NO_PROXY is cleared, requests bypass the proxy
        `os.environ["HTTP_PROXY"] = "http://127.0.0.1:${proxyTrapPort}"`,
        `os.environ["http_proxy"] = "http://127.0.0.1:${proxyTrapPort}"`,
        'os.environ.pop("NO_PROXY", None)',
        'os.environ.pop("no_proxy", None)',
        's1 = vp.api_call("/api/status", method="GET")',
        's2 = vcp.api_call("/api/providers", method="GET")',
        `shot_path = vp.capture_screenshot("demo-ide", ${JSON.stringify(screenshotLabel)})`,
        // INGRESS-06: Implicit port in http://127.0.0.1 or http://[::1] materializes canonical port 19280
        // (matching the 19280 token lookup) rather than connecting to port 80, and explicit port 0 is rejected
        'vp_implicit_base, vp_implicit_port = vp._validate_dev_server_api("http://127.0.0.1")',
        'vcp_implicit_base, vcp_implicit_port = vcp._validate_dev_server_api("http://[::1]")',
        'vp.API = "http://127.0.0.1:0"',
        'vcp.API = "http://127.0.0.1:0"',
        'port0_vp = vp.api_call("/api/status", method="GET")',
        'port0_vcp = vcp.api_call("/api/status", method="GET")',
        'port0_shot = vp.capture_screenshot("demo-ide", "port0")',
        // INGRESS-06: Non-loopback URLs must be rejected before reading or sending any local token
        'vp.API = "http://evil.example:19280"',
        'vcp.API = "http://evil.example:19280"',
        'evil_vp = vp.api_call("/api/status", method="GET")',
        'evil_vcp = vcp.api_call("/api/status", method="GET")',
        'evil_shot = vp.capture_screenshot("demo-ide", "evil")',
        'vp.API = "https://127.0.0.1:19280"',
        'https_vp = vp.api_call("/api/status", method="GET")',
        // INGRESS-06: Auth file env pointing to a different port's filename is ignored for the target port
        `vp.API = "http://127.0.0.1:${port}"`,
        `vcp.API = "http://127.0.0.1:${port}"`,
        'os.environ["ADHDEV_DEV_SERVER_AUTH_FILE"] = "/tmp/unrelated-secret-file"',
        'tok1 = vp._read_dev_token()',
        'tok2 = vcp._read_dev_token()',
        // INGRESS-06: Redirect responses must be rejected without following Location
        `vp.API = "http://127.0.0.1:${redirectPort}"`,
        `vcp.API = "http://127.0.0.1:${redirectPort}"`,
        'redir_vp = vp.api_call("/api/status", method="GET")',
        'redir_vcp = vcp.api_call("/api/status", method="GET")',
        'redir_shot = vp.capture_screenshot("demo-ide", "redir")',
        'print(json.dumps({',
        '  "vp_devMode": s1.get("devMode"),',
        '  "vcp_has_providers": isinstance(s2.get("providers"), list),',
        '  "shot_path": shot_path,',
        '  "vp_implicit_base": vp_implicit_base,',
        '  "vp_implicit_port": vp_implicit_port,',
        '  "vcp_implicit_base": vcp_implicit_base,',
        '  "vcp_implicit_port": vcp_implicit_port,',
        '  "port0_vp_err": port0_vp.get("error", ""),',
        '  "port0_vcp_err": port0_vcp.get("error", ""),',
        '  "port0_shot": port0_shot,',
        '  "tok1": tok1,',
        '  "tok2": tok2,',
        '  "evil_vp_err": evil_vp.get("error", ""),',
        '  "evil_vcp_err": evil_vcp.get("error", ""),',
        '  "evil_shot": evil_shot,',
        '  "https_vp_err": https_vp.get("error", ""),',
        '  "redir_vp_err": redir_vp.get("error", ""),',
        '  "redir_vcp_err": redir_vcp.get("error", ""),',
        '  "redir_shot": redir_shot,',
        '}))',
      ].join('\n')

      const pyRes = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('python3', ['-c', pySnippet], {
          windowsHide: true,
          env: {
            ...process.env,
            ADHDEV_CONFIG_DIR: tempRoot!,
            ADHDEV_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
            ADHDEV_DEV_SERVER_AUTH_FILE: devServerAuthFilePath(tempRoot!, port),
          },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d) => { stdout += d.toString() })
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stdout, stderr }))
      })
      expect(pyRes.status, pyRes.stderr).toBe(0)
      const parsed = JSON.parse(pyRes.stdout.trim().split('\n').pop() || '{}')
      expect(parsed.vp_devMode).toBe(true)
      expect(parsed.vcp_has_providers).toBe(true)
      expect(parsed.vp_implicit_base).toBe('http://127.0.0.1:19280')
      expect(parsed.vp_implicit_port).toBe(19280)
      expect(parsed.vcp_implicit_base).toBe('http://[::1]:19280')
      expect(parsed.vcp_implicit_port).toBe(19280)
      expect(parsed.port0_vp_err).toMatch(/Invalid DevServer port: 0/)
      expect(parsed.port0_vcp_err).toMatch(/Invalid DevServer port: 0/)
      expect(parsed.port0_shot).toBeNull()
      expect(parsed.tok1).toBe(token)
      expect(parsed.tok2).toBe(token)
      // INGRESS-06: Verify proxy trap received 0 requests and no token
      expect(proxyTrapHits).toBe(0)
      expect(proxyTrapLeakedToken).toBeUndefined()
      // INGRESS-08: Verify authenticated screenshot reached handler and wrote expected WebP binary
      expect(screenshotCaptures).toBe(1)
      expect(parsed.shot_path).toBe(expectedScreenshotFile)
      expect(existsSync(expectedScreenshotFile)).toBe(true)
      expect(readFileSync(expectedScreenshotFile).equals(fakeWebp)).toBe(true)
      // INGRESS-06: Verify non-loopback and non-http URLs are refused and redirects are never followed
      expect(parsed.evil_vp_err).toMatch(/Refusing non-loopback DevServer host/)
      expect(parsed.evil_vcp_err).toMatch(/Refusing non-loopback DevServer host/)
      expect(parsed.evil_shot).toBeNull()
      expect(parsed.https_vp_err).toMatch(/Refusing non-http DevServer URL/)
      expect(parsed.redir_vp_err).toMatch(/302/)
      expect(parsed.redir_vcp_err).toMatch(/302/)
      expect(parsed.redir_shot).toBeNull()
      expect(redirectTargetHits).toBe(0)
      expect(redirectTargetLeakedToken).toBeUndefined()
    } finally {
      redirectServer.close()
      proxyTrapServer.close()
      try { rmSync(expectedScreenshotFile, { force: true }) } catch { /* ignore */ }
    }
  })
})
