import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { ADHDEV_DEV_SERVER_TOKEN_HEADER, DevServer, buildDevServerAuthHeaders } from '../../src/daemon/dev-server.js'
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

    // 4. Legitimate local CLI / same-origin requests with valid token succeed
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
  })
})
