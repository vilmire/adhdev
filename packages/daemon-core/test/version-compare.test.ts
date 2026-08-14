import { describe, expect, it } from 'vitest'
import { compareSemver, isDowngrade, parseSemver } from '../src/version-compare'

/**
 * The comparator behind the upgrade downgrade-guard.
 *
 * The prerelease cases are the reason this module exists at all: the incident
 * version pair (1.0.49-rc.2 vs 1.0.48) is one that naive string comparison
 * gets exactly backwards, and rc.10-vs-rc.9 is one that any lexical scheme
 * gets wrong regardless of the base version.
 */

describe('parseSemver', () => {
  it('parses a plain release', () => {
    expect(parseSemver('1.0.48')).toEqual({ major: 1, minor: 0, patch: 48, prerelease: [] })
  })

  it('parses a prerelease into dot-separated identifiers', () => {
    expect(parseSemver('1.0.49-rc.2')).toEqual({ major: 1, minor: 0, patch: 49, prerelease: ['rc', '2'] })
  })

  it('tolerates a leading v', () => {
    expect(parseSemver('v1.0.48')?.patch).toBe(48)
  })

  it('discards build metadata (it never affects precedence)', () => {
    expect(parseSemver('1.0.48+build.7')).toEqual({ major: 1, minor: 0, patch: 48, prerelease: [] })
  })

  it('returns null for unparsable input', () => {
    for (const bad of ['', 'dev', '1.0', '1.0.x', 'latest', null, undefined, 42, {}]) {
      expect(parseSemver(bad as unknown)).toBeNull()
    }
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.1.0', '1.0.99')).toBe(1)
    expect(compareSemver('1.0.48', '1.0.49')).toBe(-1)
    expect(compareSemver('1.0.48', '1.0.48')).toBe(0)
  })

  it('compares numeric prerelease identifiers NUMERICALLY, not lexically', () => {
    // The case every string-based scheme gets wrong.
    expect(compareSemver('1.0.49-rc.10', '1.0.49-rc.9')).toBe(1)
    expect(compareSemver('1.0.49-rc.2', '1.0.49-rc.10')).toBe(-1)
    expect(compareSemver('1.0.49-rc.2', '1.0.49-rc.2')).toBe(0)
  })

  it('ranks a release above its own prereleases (semver §11)', () => {
    expect(compareSemver('1.0.49', '1.0.49-rc.2')).toBe(1)
    expect(compareSemver('1.0.49-rc.2', '1.0.49')).toBe(-1)
  })

  it('ranks a prerelease of a HIGHER base above a lower release', () => {
    // The incident pair. Base version decides before prerelease rules apply.
    expect(compareSemver('1.0.49-rc.2', '1.0.48')).toBe(1)
    expect(compareSemver('1.0.48', '1.0.49-rc.2')).toBe(-1)
  })

  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1)
  })

  it('ranks a shorter identifier list below an otherwise-equal longer one', () => {
    expect(compareSemver('1.0.0-rc', '1.0.0-rc.1')).toBe(-1)
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc')).toBe(1)
  })

  it('ignores build metadata for precedence', () => {
    expect(compareSemver('1.0.48+a', '1.0.48+b')).toBe(0)
  })

  it('returns null — not 0 — when either side is unparsable', () => {
    // Callers branch on `=== null`; coercing this to 0 would read as "equal".
    expect(compareSemver('dev', '1.0.0')).toBeNull()
    expect(compareSemver('1.0.0', '')).toBeNull()
    expect(compareSemver(undefined, '1.0.0')).toBeNull()
  })

  it('is antisymmetric across the incident-relevant pairs', () => {
    const versions = ['0.9.82', '1.0.48', '1.0.49-rc.2', '1.0.49-rc.10', '1.0.49', '1.1.0']
    for (const a of versions) {
      for (const b of versions) {
        const ab = compareSemver(a, b)
        const ba = compareSemver(b, a)
        expect(ab).not.toBeNull()
        // `+ 0` collapses -0 to 0; toBe() uses Object.is, which distinguishes them.
        expect(Math.sign(ab as number) + 0).toBe(Math.sign(-(ba as number)) + 0)
      }
    }
  })

  it('sorts the release history into the expected order', () => {
    const sorted = ['1.0.49', '1.0.48', '1.0.49-rc.10', '0.9.82', '1.0.49-rc.2']
      .sort((a, b) => compareSemver(a, b) as number)
    expect(sorted).toEqual(['0.9.82', '1.0.48', '1.0.49-rc.2', '1.0.49-rc.10', '1.0.49'])
  })
})

describe('isDowngrade', () => {
  it('detects the incident: 1.0.49-rc.2 → 1.0.48', () => {
    expect(isDowngrade('1.0.49-rc.2', '1.0.48')).toBe(true)
  })

  it('does not flag a normal upgrade', () => {
    expect(isDowngrade('1.0.49', '1.0.50')).toBe(false)
    expect(isDowngrade('1.0.49-rc.2', '1.0.49-rc.10')).toBe(false)
    expect(isDowngrade('1.0.49-rc.2', '1.0.49')).toBe(false)
  })

  it('does not flag a same-version reinstall', () => {
    expect(isDowngrade('1.0.49', '1.0.49')).toBe(false)
    expect(isDowngrade('1.0.49-rc.2', '1.0.49-rc.2')).toBe(false)
  })

  it('fails OPEN (false) when either version is unparsable', () => {
    // An unknown direction must never block an upgrade — a false block would
    // freeze the fleet with no remote way to unfreeze it.
    expect(isDowngrade('dev-build', '1.0.48')).toBe(false)
    expect(isDowngrade('1.0.49', 'nightly')).toBe(false)
    expect(isDowngrade(null, '1.0.48')).toBe(false)
  })
})
