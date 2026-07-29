import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REGISTRY_BASE_URL,
  DEFAULT_PROVIDER_TARBALL_URL,
  REGISTRY_URL_ENV_VAR,
  PROVIDER_TARBALL_URL_ENV_VAR,
  resolveRegistryBaseUrl,
  resolveProviderTarballUrl,
  resolveProviderTarballTarget,
} from '../../src/config/registry-resolver.js'

// Hermetic env fixtures — never touch the real process.env so tests stay order-independent.
const emptyEnv: NodeJS.ProcessEnv = {}
function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides }
}

describe('resolveRegistryBaseUrl', () => {
  it('falls back to the vendor default when nothing is configured', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv)).toBe(DEFAULT_REGISTRY_BASE_URL)
    // Default is byte-identical to the literal it replaced.
    expect(DEFAULT_REGISTRY_BASE_URL).toBe('https://api.adhf.dev/api/v1/registry')
  })

  it('uses the env var over the default', () => {
    const env = envWith({ [REGISTRY_URL_ENV_VAR]: 'https://registry.example.com/v1' })
    expect(resolveRegistryBaseUrl(undefined, env)).toBe('https://registry.example.com/v1')
  })

  it('prefers the explicit config field over env and default', () => {
    const env = envWith({ [REGISTRY_URL_ENV_VAR]: 'https://env.example.com/v1' })
    expect(resolveRegistryBaseUrl('https://config.example.com/v1', env)).toBe(
      'https://config.example.com/v1',
    )
  })

  it('ignores empty/whitespace config and env values', () => {
    expect(resolveRegistryBaseUrl('   ', emptyEnv)).toBe(DEFAULT_REGISTRY_BASE_URL)
    expect(resolveRegistryBaseUrl(null, envWith({ [REGISTRY_URL_ENV_VAR]: '' }))).toBe(
      DEFAULT_REGISTRY_BASE_URL,
    )
  })

  it('strips trailing slashes so callers can safely append paths', () => {
    expect(resolveRegistryBaseUrl('https://registry.example.com/v1/', emptyEnv)).toBe(
      'https://registry.example.com/v1',
    )
    expect(resolveRegistryBaseUrl('https://registry.example.com/v1///', emptyEnv)).toBe(
      'https://registry.example.com/v1',
    )
  })

  it('trims surrounding whitespace on the resolved value', () => {
    expect(resolveRegistryBaseUrl('  https://registry.example.com/v1  ', emptyEnv)).toBe(
      'https://registry.example.com/v1',
    )
  })
})

// rc.21 live M1 canary root cause: a preview daemon (serverUrl resolved to
// https://api-preview.adhf.dev) with no registry override fell back to the
// hardcoded PRODUCTION registry, which ignores ?channel=preview and returns
// legacy digest-less rows (51 ENTRY_NON_ACTIVATABLE). The registry base must
// derive from the already-resolved daemon serverUrl.
describe('resolveRegistryBaseUrl serverUrl derivation (rc.21)', () => {
  const PREVIEW_SERVER = 'https://api-preview.adhf.dev'
  const PREVIEW_REGISTRY = 'https://api-preview.adhf.dev/api/v1/registry'

  it('derives the registry base from the resolved serverUrl when no override is set', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, PREVIEW_SERVER)).toBe(PREVIEW_REGISTRY)
  })

  it('stable server derives the byte-identical stable default', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, 'https://api.adhf.dev')).toBe(
      DEFAULT_REGISTRY_BASE_URL,
    )
  })

  it('absent/blank serverUrl falls back to the vendor default (unchanged)', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv)).toBe(DEFAULT_REGISTRY_BASE_URL)
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, null)).toBe(DEFAULT_REGISTRY_BASE_URL)
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, '   ')).toBe(DEFAULT_REGISTRY_BASE_URL)
  })

  it('explicit config and env overrides still beat serverUrl derivation', () => {
    expect(resolveRegistryBaseUrl('https://config.example.com/v1', emptyEnv, PREVIEW_SERVER)).toBe(
      'https://config.example.com/v1',
    )
    const env = envWith({ [REGISTRY_URL_ENV_VAR]: 'https://env.example.com/v1' })
    expect(resolveRegistryBaseUrl(undefined, env, PREVIEW_SERVER)).toBe(
      'https://env.example.com/v1',
    )
  })

  it('derives from a custom server origin (self-host deployments)', () => {
    expect(
      resolveRegistryBaseUrl(undefined, emptyEnv, 'https://adhdev.internal.example:8443'),
    ).toBe('https://adhdev.internal.example:8443/api/v1/registry')
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, 'http://127.0.0.1:3100')).toBe(
      'http://127.0.0.1:3100/api/v1/registry',
    )
  })

  it('normalizes trailing/path forms exactly once (never a double /api/v1/registry)', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, `${PREVIEW_SERVER}/`)).toBe(PREVIEW_REGISTRY)
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, PREVIEW_REGISTRY)).toBe(PREVIEW_REGISTRY)
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, `${PREVIEW_REGISTRY}/`)).toBe(PREVIEW_REGISTRY)
  })

  it('ignores an unparseable or non-http serverUrl and falls back to the vendor default', () => {
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, 'not a url')).toBe(DEFAULT_REGISTRY_BASE_URL)
    expect(resolveRegistryBaseUrl(undefined, emptyEnv, 'ftp://api-preview.adhf.dev')).toBe(
      DEFAULT_REGISTRY_BASE_URL,
    )
  })
})

describe('resolveProviderTarballUrl', () => {
  it('falls back to the vendor default when nothing is configured', () => {
    expect(resolveProviderTarballUrl(undefined, emptyEnv)).toBe(DEFAULT_PROVIDER_TARBALL_URL)
    expect(DEFAULT_PROVIDER_TARBALL_URL).toBe(
      'https://github.com/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz',
    )
  })

  it('uses the env var over the default', () => {
    const env = envWith({
      [PROVIDER_TARBALL_URL_ENV_VAR]: 'https://mirror.example.com/providers.tar.gz',
    })
    expect(resolveProviderTarballUrl(undefined, env)).toBe(
      'https://mirror.example.com/providers.tar.gz',
    )
  })

  it('prefers the explicit config field over env and default', () => {
    const env = envWith({
      [PROVIDER_TARBALL_URL_ENV_VAR]: 'https://env.example.com/providers.tar.gz',
    })
    expect(
      resolveProviderTarballUrl('https://config.example.com/providers.tar.gz', env),
    ).toBe('https://config.example.com/providers.tar.gz')
  })

  it('ignores empty/whitespace config and env values', () => {
    expect(resolveProviderTarballUrl('  ', emptyEnv)).toBe(DEFAULT_PROVIDER_TARBALL_URL)
  })
})

describe('resolveProviderTarballTarget', () => {
  it('splits the default URL into hostname and path', () => {
    const target = resolveProviderTarballTarget(undefined, emptyEnv)
    expect(target.url).toBe(DEFAULT_PROVIDER_TARBALL_URL)
    expect(target.hostname).toBe('github.com')
    expect(target.path).toBe('/vilmire/adhdev-providers/archive/refs/heads/main.tar.gz')
  })

  it('splits a self-hosted override URL, preserving the query string', () => {
    const target = resolveProviderTarballTarget(
      'https://mirror.example.com/dl/providers.tar.gz?ref=main',
      emptyEnv,
    )
    expect(target.hostname).toBe('mirror.example.com')
    expect(target.path).toBe('/dl/providers.tar.gz?ref=main')
  })

  it('honors the env override', () => {
    const env = envWith({
      [PROVIDER_TARBALL_URL_ENV_VAR]: 'https://mirror.example.com/p.tar.gz',
    })
    const target = resolveProviderTarballTarget(undefined, env)
    expect(target.url).toBe('https://mirror.example.com/p.tar.gz')
    expect(target.hostname).toBe('mirror.example.com')
  })
})
