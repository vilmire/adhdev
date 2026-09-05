/**
 * (SHELL-FRESHNESS) Tests for detecting that the running SPA shell is older
 * than the deployed build.
 *
 * The defect this covers is NOT a caching bug — `index.html` is already served
 * `no-cache, no-store` and the service worker has no fetch handler. The bug is
 * that `no-store` governs how a document is FETCHED and says nothing about a
 * document already parsed and executing: a dashboard left open for hours keeps
 * running its original bundle forever, because nothing ever tells it otherwise.
 * `build-info.json` was already being emitted by the build and no client read it.
 */
import { describe, expect, it } from 'vitest'
import { isShellStale, type ShellBuildInfo } from '../../src/hooks/useShellFreshness'

const RUNNING: ShellBuildInfo = {
  commit: 'aaaaaaaaaaaa1111',
  packageVersion: '1.2.3',
}

describe('shell freshness detection', () => {
  it('★ flags stale when the deployed commit differs from the running one', () => {
    expect(isShellStale(RUNNING, { commit: 'bbbbbbbbbbbb2222', packageVersion: '1.2.4' })).toBe(true)
  })

  it('★ does NOT flag when the deployed build matches the running one', () => {
    // The banner must stay hidden on the overwhelmingly common path; a banner
    // that shows on a current build is worse than none, because it survives the
    // reload it asks for and teaches the user to ignore it.
    expect(isShellStale(RUNNING, { commit: RUNNING.commit, packageVersion: RUNNING.packageVersion })).toBe(false)
  })

  it('prefers commit over version — a rebuild of the same version is still stale', () => {
    // Preview redeploys land repeatedly on one package version; commit is the
    // only field that actually moves between them.
    expect(isShellStale(RUNNING, { commit: 'cccccccccccc3333', packageVersion: '1.2.3' })).toBe(true)
  })

  it('falls back to package version when a commit is missing on either side', () => {
    expect(isShellStale({ packageVersion: '1.2.3' }, { packageVersion: '1.2.4' })).toBe(true)
    expect(isShellStale({ packageVersion: '1.2.3' }, { packageVersion: '1.2.3' })).toBe(false)
  })

  it('fails CLOSED on unknown / missing / unfetched build identity', () => {
    // Every one of these is "we cannot tell", and "we cannot tell" must never
    // render as "update available".
    expect(isShellStale(RUNNING, null)).toBe(false)
    expect(isShellStale(RUNNING, {})).toBe(false)
    expect(isShellStale({ commit: 'unknown' }, { commit: 'bbbbbbbbbbbb2222' })).toBe(false)
    expect(isShellStale(RUNNING, { commit: 'unknown' })).toBe(false)
    expect(isShellStale({}, { commit: 'bbbbbbbbbbbb2222', packageVersion: '9.9.9' })).toBe(false)
  })
})
