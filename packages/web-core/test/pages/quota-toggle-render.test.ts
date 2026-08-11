import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// PER-PROVIDER QUOTA TOGGLE on the machine page.
//
// `machineProviders[type].enabled` ("this machine USES provider X") gates
// launching and mesh claims; the new `quotaEnabled` axis gates ONLY the quota
// probe. The two are independent: a machine can use a provider and still not
// want its quota read here. Unset = enabled, so the UI renders a missing key
// as ON.
//
// Contracts:
//  - the toggle is offered exactly for providers with a shipped quota fetcher
//    (claude-cli / codex-cli / kimi — REFRESHERS in daemon-core quota/refresh.ts)
//  - it renders ABOVE the codex-only account-label toggle, with a distinct
//    label, so the two cannot be confused
//  - enabling CLAUDE asks first: the daemon installs a statusLine wrapper
//    into ~/.claude/settings.json (the only quota path Claude Code offers)
//  - disabling, and codex/kimi in both directions, never confirm

const ROW = path.join(import.meta.dirname, '../../src/pages/machine/InstalledProviderRow.tsx')
const TAB = path.join(import.meta.dirname, '../../src/pages/machine/ProvidersTab.tsx')
const rowSource = fs.readFileSync(ROW, 'utf8')
const tabSource = fs.readFileSync(TAB, 'utf8')

describe('quota toggle — provider set', () => {
  it('QUOTA_PROVIDERS derives from the shared list, not a local copy', () => {
    // Was a hand-copied literal of REFRESHERS (daemon-core quota/refresh.ts).
    // It now derives from mesh-shared's QUOTA_SUPPORTED_PROVIDERS, which a
    // drift gate pins to REFRESHERS itself
    // (daemon-core test/quota/quota-supported-providers-drift.test.ts), so the
    // set cannot fall out of step with the shipped fetchers. Asserting the
    // derivation rather than the membership is the point: a re-introduced
    // literal fails here even if it happens to be correct today.
    expect(tabSource).toContain('const QUOTA_PROVIDERS = new Set(QUOTA_SUPPORTED_PROVIDERS)')
    expect(tabSource).toContain("QUOTA_SUPPORTED_PROVIDERS, type MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'")
  })

  it('reads and writes through the dedicated command pair', () => {
    expect(tabSource).toContain("'get_quota_provider_enabled'")
    expect(tabSource).toContain("'set_quota_provider_enabled'")
  })

  it('renders a missing key as ON (absent = enabled)', () => {
    expect(tabSource).toContain('quotaEnabled[prov.type] ?? true')
  })
})

describe('quota toggle — row rendering', () => {
  it('renders the toggle with its own label, wired to onQuotaToggle', () => {
    expect(rowSource).toContain('machine.providerRow.quotaTracking')
    expect(rowSource).toContain('machine.providerRow.quotaTrackingHint')
    expect(rowSource).toContain('onQuotaToggle')
    expect(rowSource).toContain('{onQuotaToggle && quotaEnabled !== undefined && (')
  })

  it('renders ABOVE the account-label block so the two toggles cannot be confused', () => {
    expect(rowSource.indexOf('machine.providerRow.quotaTracking'))
      .toBeLessThan(rowSource.indexOf('machine.providerRow.quotaAccountLabel'))
  })
})

describe('quota toggle — claude confirm', () => {
  it('claude enabling goes through an inline confirm step', () => {
    expect(rowSource).toContain('confirmQuotaEnable')
    expect(rowSource).toContain('machine.providerRow.quotaClaudeConfirmTitle')
    expect(rowSource).toContain('machine.providerRow.quotaClaudeConfirmBody')
    expect(rowSource).toContain('machine.providerRow.quotaClaudeConfirmOk')
    expect(rowSource).toContain('machine.providerRow.quotaClaudeConfirmCancel')
  })

  it('the confirm state is entered only for claude-cli being turned ON', () => {
    // Only claude has a user-file side effect (the statusLine wrapper
    // install). Disabling, and codex/kimi in both directions, never confirm.
    expect(rowSource).toContain("prov.type === 'claude-cli' && !quotaEnabled")
  })
})

describe('i18n', () => {
  const keys = [
    'quotaTracking', 'quotaTrackingHint', 'quotaTrackingOn', 'quotaTrackingOff',
    'quotaClaudeConfirmTitle', 'quotaClaudeConfirmBody',
    'quotaClaudeConfirmOk', 'quotaClaudeConfirmCancel',
  ]

  it('the claude confirm body states the facts the user is consenting to', () => {
    const file = path.join(import.meta.dirname, '../../src/i18n/locales/en/common.json')
    const body = JSON.parse(fs.readFileSync(file, 'utf8')).machine.providerRow.quotaClaudeConfirmBody
    expect(body).toContain('statusLine')
    expect(body).toContain('~/.claude/settings.json')
    expect(body).toContain('backed up')
    expect(body).toContain('claude:uninstall')
  })

  it('every quota-toggle key exists in all shipped locales', () => {
    for (const lang of ['en', 'ko', 'ja', 'zh-CN', 'es']) {
      const file = path.join(import.meta.dirname, `../../src/i18n/locales/${lang}/common.json`)
      const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const key of keys) {
        expect(dict.machine?.providerRow?.[key], `${lang} is missing ${key}`).toBeTruthy()
      }
    }
  })
})
