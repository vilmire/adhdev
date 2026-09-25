import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { DevServer } from '../../src/daemon/dev-server.js'
import { ProviderLoader } from '../../src/providers/provider-loader.js'
import { validateCliProviderManifest, validateAcpProviderManifest } from '../../src/providers/sdk/v1/index.js'
import { validateFsmSpec } from '../../src/providers/spec/fsm-loader.js'

// These tests drive the REAL `/api/scaffold` HTTP route (handleScaffold ->
// genScaffoldFiles / buildCliProviderV1Scaffold / buildAcpProviderV1Scaffold)
// exactly as web-devconsole and the online-first path of `adhdev provider
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

async function startServer(userDir: string): Promise<{ server: DevServer; port: number }> {
  const loader = new ProviderLoader({ userDir, disableUpstream: true })
  loader.loadAll()
  const server = new DevServer({
    providerLoader: loader,
    cdpManagers: new Map(),
    logFn: () => {},
  })
  // DevServer.start(port) binds to a fixed port (there is no "pick any free
  // port" mode) and resolves even on EADDRINUSE (treated as non-fatal —
  // see dev-server.ts start()), so pick a high, unlikely-to-collide port
  // per test run instead of hardcoding DEV_SERVER_PORT (19280), which a
  // real running daemon may already hold.
  const port = 20000 + Math.floor(Math.random() * 10000)
  await server.start(port)
  return { server, port }
}

function postScaffold(port: number, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/scaffold',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, json: JSON.parse(data) })
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

  it('category=acp writes a single provider.v1.json that passes validateAcpProviderManifest', async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-devserver-scaffold-'))
    const started = await startServer(tempRoot)
    server = started.server

    const res = await postScaffold(started.port, { type: 'my-acp', name: 'My ACP', category: 'acp' })
    expect(res.status).toBe(201)
    expect(res.json.files).toEqual(['provider.v1.json'])

    const targetDir = res.json.path as string
    const manifestPath = path.join(targetDir, 'provider.v1.json')
    expect(existsSync(manifestPath)).toBe(true)
    expect(existsSync(path.join(targetDir, 'specs'))).toBe(false)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const result = validateAcpProviderManifest(manifest)
    expect(result.ok, JSON.stringify((result as any).issues)).toBe(true)
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
})
