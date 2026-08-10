import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// PROVIDER SPEC PIN on the machine page.
//
// A provider fix does not reach a machine on its own: the verified-channel pin
// advances only on an explicit activation (deliberate — reproducibility,
// last-known-good, rollback). So a machine can load an old spec indefinitely
// with nothing on screen saying so. That is not hypothetical: a published kimi
// resume fix sat unadopted for a day while `.upstream` showed the new version,
// which is also why the pin must render SEPARATELY from the manifest/binary
// version rather than replacing it — they answer different questions and
// routinely disagree.
//
// Contracts:
//  - pin absent      → nothing renders (no empty row implying "no pin known")
//  - pin present     → active version renders
//  - stale           → a badge naming the version the channel offers
//  - update          → confirm step (it changes what later sessions load)
//  - rollback        → NO confirm step (local flip back to what was running)

const ROW = path.join(import.meta.dirname, '../../src/pages/machine/InstalledProviderRow.tsx')
const TAB = path.join(import.meta.dirname, '../../src/pages/machine/ProvidersTab.tsx')
const rowSource = fs.readFileSync(ROW, 'utf8')
const tabSource = fs.readFileSync(TAB, 'utf8')

describe('provider pin — machine page row', () => {
  it('renders every pin field the operator needs to judge staleness', () => {
    for (const key of ['labelSpecPin', 'labelActivatedAt', 'labelPreviousPin', 'labelDigest']) {
      expect(rowSource, `${key} must be rendered`).toContain(`machine.providerRow.${key}`)
    }
  })

  it('gates each pin field on the pin existing (absent → renders nothing)', () => {
    // `pin?.x && (...)` — an unconditional row would imply the daemon reported
    // a pin when it did not.
    expect(rowSource).toContain('{pin?.activeVersion && (')
    expect(rowSource).toContain('{pin?.activatedAt && (')
    expect(rowSource).toContain('{pin?.previousVersion && (')
    expect(rowSource).toContain('{pin?.digest && (')
  })

  it('shows the stale badge only when the channel actually offers more', () => {
    // Both conditions: stale AND a latest version to name. A badge that cannot
    // say what it is behind is not actionable.
    expect(rowSource).toContain('{pin.stale && pin.latestVersion && (')
    expect(rowSource).toContain('machine.providerRow.specPinStale')
  })

  it('keeps the spec pin distinct from the CLI/manifest version', () => {
    // Both must render. Collapsing them is the canon-identity trap: a machine
    // can run kimi-code 1.2.3 while pinned to kimi spec 1.0.0.
    expect(rowSource).toContain('machine.providerRow.labelVersion')
    expect(rowSource).toContain('machine.providerRow.labelSpecPin')
  })
})

describe('provider pin — actions', () => {
  it('update asks for confirmation before moving the pointer', () => {
    expect(rowSource).toContain('confirmActivate')
    expect(rowSource).toContain('machine.providerRow.specPinUpdateConfirm')
    expect(rowSource).toContain('machine.providerRow.specPinCancel')
  })

  it('rollback does NOT ask — it returns to what was already running', () => {
    // Deliberate asymmetry. Rollback is the action reached for when an update
    // just broke something; a dialog there is friction at the worst moment.
    const rollbackBlock = rowSource.slice(rowSource.indexOf('onRollbackUpdate && pin?.previousVersion'))
    expect(rollbackBlock).not.toContain('setConfirmActivate(true)')
    expect(rowSource).toContain('machine.providerRow.specPinRollback')
  })

  it('offers rollback only when there is a target to roll back to', () => {
    expect(rowSource).toContain('{onRollbackUpdate && pin?.previousVersion && (')
  })
})

describe('provider pin — data source', () => {
  it('reads pins with the READ-ONLY command, never the activating one', () => {
    // check_provider_updates is safe on mount BECAUSE it no longer activates.
    // Calling activate_provider_updates here would move every machine's
    // pointer just by opening the tab. (handleInstallNewType — the explicit
    // per-type install button — is the first declaration after fetchPins and
    // legitimately activates, so the mount-path slice ends there.)
    const fetchBlock = tabSource.slice(tabSource.indexOf('const fetchPins'), tabSource.indexOf('const handleInstallNewType'))
    expect(fetchBlock).toContain("'check_provider_updates'")
    expect(fetchBlock).not.toContain("'activate_provider_updates'")
  })

  it('activation, new-type install and rollback are behind explicit handlers', () => {
    expect(tabSource).toContain("'activate_provider_updates'")
    expect(tabSource).toContain("'rollback_provider_update'")
    // New-type install (kimi class) rides activate_provider_updates {types}.
    expect(tabSource).toContain('const handleInstallNewType')
    const installBlock = tabSource.slice(tabSource.indexOf('const handleInstallNewType'), tabSource.indexOf('const handleActivatePins'))
    expect(installBlock).toContain('types: [providerType]')
  })

  it('re-reads the pin after acting, rather than assuming it moved', () => {
    const activateBlock = tabSource.slice(tabSource.indexOf('const handleActivatePins'), tabSource.indexOf('const handleRollbackPin'))
    expect(activateBlock).toContain('await fetchPins()')
  })

  it('unwraps both standalone and cloud response shapes', () => {
    const fetchBlock = tabSource.slice(tabSource.indexOf('const fetchPins'), tabSource.indexOf('const handleActivatePins'))
    expect(fetchBlock).toContain("'result' in")
  })
})

describe('i18n', () => {
  it('every pin key exists in all shipped locales', () => {
    const keys = [
      'labelSpecPin', 'labelActivatedAt', 'labelPreviousPin', 'labelDigest',
      'specPinStale', 'specPinStaleHint', 'specPinUpdate', 'specPinUpdateHint',
      'specPinUpdateConfirm', 'specPinUpdating', 'specPinCancel',
      'specPinRollback', 'specPinRollbackHint', 'specPinRollingBack',
    ]
    for (const lang of ['en', 'ko', 'ja', 'zh-CN', 'es']) {
      const file = path.join(import.meta.dirname, `../../src/i18n/locales/${lang}/common.json`)
      const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const key of keys) {
        expect(dict.machine?.providerRow?.[key], `${lang} is missing ${key}`).toBeTruthy()
      }
    }
  })
})
