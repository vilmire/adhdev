import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  buildCliProviderV1Scaffold,
  buildAcpProviderV1Scaffold,
  resolveCliSpecPath,
} from '../../src/providers/scaffold-v1.js'
import { validateCliProviderManifest, validateAcpProviderManifest } from '../../src/providers/sdk/v1/index.js'
import { validateFsmSpec } from '../../src/providers/spec/fsm-loader.js'

// Moved verbatim from packages/daemon-cloud/test/provider-init-scaffold.test.ts
// (2026-09-25) when buildCliProviderV1Scaffold / buildAcpProviderV1Scaffold /
// resolveCliSpecPath moved from daemon-cloud into daemon-core so the
// DevServer /api/scaffold route (daemon/dev-server.ts) and `adhdev provider
// init`'s offline path share one implementation instead of two. These tests
// run the scaffold output through the REAL daemon-core validators
// (validateCliProviderManifest / validateAcpProviderManifest /
// validateFsmSpec) — the same code path the daemon runs at install/load time
// (providers/provider-loader-manifest-scan.ts) and at launch time
// (providers/spec/route.ts).

describe('buildCliProviderV1Scaffold', () => {
  it('produces a manifest that passes validateCliProviderManifest', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'my-cli' })
    const result = validateCliProviderManifest(scaffold.manifest)
    expect(result.ok, JSON.stringify((result as any).issues)).toBe(true)
  })

  it('produces a spec that passes validateFsmSpec', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'my-cli' })
    const errors = validateFsmSpec(scaffold.spec)
    expect(errors).toEqual([])
  })

  it('manifest.compatibility points at the spec file actually written', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'my-cli' })
    const compat = (scaffold.manifest as any).compatibility
    expect(Array.isArray(compat) && compat.length > 0).toBe(true)
    expect(compat[0].spec).toBe('specs/1.0.json')
    expect(scaffold.specPath).toBe(path.join('specs', '1.0.json'))
  })

  it('derives binary from type when binary is omitted', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'foo-cli' })
    expect(scaffold.binary).toBe('foo')
    expect((scaffold.manifest as any).binary).toBe('foo')
    expect((scaffold.manifest as any).spawn.command).toBe('foo')
  })

  it('respects an explicit binary override', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'foo-cli', binary: 'foo-bin' })
    expect(scaffold.binary).toBe('foo-bin')
  })

  it('derives a title-cased display name from type', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'my-cool-cli' })
    expect(scaffold.name).toBe('My Cool Cli')
  })

  it('spec has exactly one initial state (break-once: FSM validator catches zero/many)', () => {
    const scaffold = buildCliProviderV1Scaffold({ type: 'my-cli' })
    const initialCount = (scaffold.spec as any).states.filter((s: any) => s.initial).length
    expect(initialCount).toBe(1)
  })
})

describe('buildAcpProviderV1Scaffold', () => {
  it('produces a manifest that passes validateAcpProviderManifest', () => {
    const scaffold = buildAcpProviderV1Scaffold({ type: 'my-acp' })
    const result = validateAcpProviderManifest(scaffold.manifest)
    expect(result.ok, JSON.stringify((result as any).issues)).toBe(true)
  })

  it('manifest fails the CLI schema (category const mismatch) — validate must not use the cli validator for acp', () => {
    const scaffold = buildAcpProviderV1Scaffold({ type: 'my-acp' })
    const result = validateCliProviderManifest(scaffold.manifest)
    expect(result.ok).toBe(false)
  })
})

describe('resolveCliSpecPath', () => {
  it('finds compatibility[].spec relative to the manifest dir', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname)
    const manifest = { compatibility: [{ ideVersion: '>=0.0.0', spec: path.relative(dir, new URL(import.meta.url).pathname).split(path.sep).join('/') }] }
    const resolved = resolveCliSpecPath(dir, manifest as any)
    expect(resolved).toBe(new URL(import.meta.url).pathname)
  })

  it('returns null when nothing on the chain exists (break-once: this is the formatNoResolvableSpecError trigger)', () => {
    const resolved = resolveCliSpecPath('/nonexistent/provider/dir/that/should/not/exist', {})
    expect(resolved).toBe(null)
  })
})
