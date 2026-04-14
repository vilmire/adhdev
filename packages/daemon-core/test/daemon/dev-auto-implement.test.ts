import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProviderLoader } from '../../src/providers/provider-loader.js'
import { resolveAutoImplWritableProviderDir } from '../../src/daemon/dev-auto-implement.js'
import type { DevServerContext } from '../../src/daemon/dev-server-types.js'

function writeProvider(root: string, category: string, type: string, data: Record<string, unknown>) {
  const dir = path.join(root, category, type)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'provider.json'), JSON.stringify(data, null, 2), 'utf-8')
  return dir
}

describe('resolveAutoImplWritableProviderDir', () => {
  it('creates a writable user copy without mutating provider.json disableUpstream', () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'adhdev-auto-impl-'))
    const userRoot = path.join(tempRoot, 'user-providers')
    const upstreamRoot = path.join(tempRoot, 'upstream-providers')

    try {
      const sourceDir = writeProvider(upstreamRoot, 'cli', 'foo-cli', {
        type: 'foo-cli',
        name: 'Foo CLI',
        category: 'cli',
        spawn: { command: 'foo' },
      })

      const loader = new ProviderLoader({ userDir: userRoot, disableUpstream: true })
      ;(loader as any).upstreamDir = upstreamRoot
      loader.loadAll()

      const ctx: DevServerContext = {
        providerLoader: loader,
        cdpManagers: new Map(),
        instanceManager: null,
        cliManager: null,
        getCdp: () => null,
        json: () => {},
        readBody: async () => ({}),
        log: () => {},
        autoImplSSEClients: [],
        sendAutoImplSSE: () => {},
        autoImplStatus: { running: false, type: null, progress: [] },
        autoImplProcess: null,
        sendCliSSE: () => {},
        handleRunScript: async () => {},
        findProviderDir: () => sourceDir,
        getLatestScriptVersionDir: () => null,
      }

      const result = resolveAutoImplWritableProviderDir(ctx, 'cli', 'foo-cli')
      expect(result.dir).toBe(path.resolve(userRoot, 'cli', 'foo-cli'))

      const providerJson = JSON.parse(readFileSync(path.join(result.dir!, 'provider.json'), 'utf-8'))
      expect(providerJson.disableUpstream).toBeUndefined()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
