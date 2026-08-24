import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { collectQuotaEntries, describeQuotaFailure, formatQuotaWindow } from '../../src/utils/quota-format'

// Quota on the two MACHINE-scoped surfaces: the machine detail page's Overview
// tab and the chat session-info dialog. Both receive a bare
// Record<string, MeshNodeFactsProviderQuota> (get_machine_runtime_stats →
// machine.quota / get_session_info → quota), unlike the mesh Status tab whose
// input is a RepoMeshNodeStatus — hence the shared collectQuotaEntries step.
//
// Contracts:
//  - quota present  → rows render
//  - quota absent   → NOTHING renders (no empty card/heading). A machine whose
//                     15-minute refresh has not ticked has reported nothing;
//                     an empty "Plan quota" card would imply a reading exists.
//  - unavailable/error → the provider still shows, with failureKind.
//  - the dialog uses the COMPACT form: Row + chips, no freshness stamp and no
//    card chrome (those only mean something when comparing machines).

const OVERVIEW = path.join(import.meta.dirname, '../../src/pages/machine/OverviewTab.tsx')
const DIALOG = path.join(import.meta.dirname, '../../src/components/dashboard/SessionInfoDialog.tsx')
const overviewSource = fs.readFileSync(OVERVIEW, 'utf8')
const dialogSource = fs.readFileSync(DIALOG, 'utf8')

const OK_QUOTA = {
  'codex-cli': {
    provider: 'codex-cli', status: 'ok', updatedAt: 1, error: null,
    session: { usedPercent: 26, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
  },
  'claude-cli': {
    provider: 'claude-cli', status: 'ok', updatedAt: 1, error: null,
    session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
    weekly: { usedPercent: 2, windowMinutes: 10080, resetsAt: null },
  },
}

describe('machine-scoped quota entries (shared by both surfaces)', () => {
  it('lists providers in a stable display order when quota is present', () => {
    const entries = collectQuotaEntries(OK_QUOTA)
    expect(entries.map(e => e.provider)).toEqual(['claude-cli', 'codex-cli'])
    expect(formatQuotaWindow(entries[1].quota.session)).toBe('26.0% used')
  })

  it('returns nothing at all when the machine reported no quota', () => {
    // Every "we have not heard a quota" shape must collapse to [] so the caller
    // renders nothing rather than an empty section.
    expect(collectQuotaEntries(undefined)).toEqual([])
    expect(collectQuotaEntries(null)).toEqual([])
    expect(collectQuotaEntries({})).toEqual([])
    expect(collectQuotaEntries('nope')).toEqual([])
    expect(collectQuotaEntries(['nope'])).toEqual([])
    expect(collectQuotaEntries({ 'codex-cli': null })).toEqual([])
    // An ARRAY of quota-shaped objects must not be walked as a map: its indices
    // would become provider ids ("0", "1"), inventing providers that do not
    // exist. The per-value check alone does not catch this — the container
    // itself has to be rejected.
    expect(collectQuotaEntries([{ provider: 'codex-cli', status: 'ok' }])).toEqual([])
  })

  it('keeps a provider the machine looked at but could not read, with failureKind', () => {
    const entries = collectQuotaEntries({
      'codex-cli': {
        provider: 'codex-cli', status: 'unavailable', session: null, weekly: null,
        updatedAt: 1, error: 'codex CLI is not installed', metadata: { failureKind: 'not-installed' },
      },
    })
    expect(entries).toHaveLength(1)
    // No windows → the caller shows the failure text instead of usage chips.
    expect(formatQuotaWindow(entries[0].quota.session)).toBeNull()
    // The kind is already implied by the message here, so it is not repeated.
    expect(describeQuotaFailure(entries[0].quota)).toBe('codex CLI is not installed')

    // …but a kind the message does NOT carry is appended, because that is what
    // separates "not installed" from "channel broken".
    const opaque = collectQuotaEntries({
      kimi: {
        provider: 'kimi', status: 'error', session: null, weekly: null,
        updatedAt: 1, error: 'request failed', metadata: { failureKind: 'expired-token' },
      },
    })
    expect(describeQuotaFailure(opaque[0].quota)).toBe('request failed (expired token)')
  })
})

describe('machine detail — Overview tab', () => {
  it('renders a Plan quota card, mounted in the tab', () => {
    expect(overviewSource).toContain('<PlanQuotaCard machine={machine} />')
    expect(overviewSource).toContain("t('machine.quota.title')")
    // Uses the page's existing Card/label language, not a new style system.
    expect(overviewSource).toMatch(/function PlanQuotaCard[\s\S]{0,900}<Card padding="lg"/)
  })

  it('self-hides entirely when the machine reported no quota', () => {
    // The guard that keeps an empty "Plan quota" card off the page.
    expect(overviewSource).toMatch(/collectQuotaEntries\(machine\.quota\)[\s\S]{0,120}entries\.length === 0\) return null/)
  })

  it('shows tinted window chips, and the failure text when there are none', () => {
    // Content assembly (windows, tones, failure text) comes from the shared
    // view-model — the card only styles the kinds. The per-surface copies of
    // this logic are what drifted before; quota-display-model.test.ts guards
    // the full consumer set.
    expect(overviewSource).toContain('buildQuotaDisplayModel(quota)')
    expect(overviewSource).toContain("model.kind === 'chips'")
    expect(overviewSource).toContain("model.kind === 'failure'")
  })

  it('imports quota helpers only from utils/quota-format', () => {
    // The MeshGraph subtree is mesh-observability UI; a machine page reaching
    // into it would be a layering inversion — that is why the helpers moved.
    expect(overviewSource).toContain("from '../../utils/quota-format'")
    expect(overviewSource).not.toContain('MeshObservabilitySurface')
    expect(overviewSource).not.toContain('meshSurfaceHelpers')
  })
})

describe('session info dialog — compact form', () => {
  it('renders one Row per provider with usage chips', () => {
    expect(dialogSource).toContain('collectQuotaEntries(data.quota)')
    // The Row label is provider + (when reported) the account it belongs to,
    // joined only when there is something to join — see formatQuotaAccount.
    expect(dialogSource).toMatch(/<Row\s+key=\{provider\}/)
    expect(dialogSource).toContain("k={[quotaProviderLabel(provider), formatQuotaAccount(quota)].filter(Boolean).join(' · ')}")
    // Chip content (window labels, tones, failure text) comes from the shared
    // view-model; the dialog only picks the compact Row styling.
    expect(dialogSource).toContain('buildQuotaDisplayModel(quota)')
    expect(dialogSource).toMatch(/model\.chips\.map\(chip => \(\s*<QuotaChip/)
    expect(dialogSource).toContain("model.kind === 'usage'")
  })

  it('OMITS the freshness stamp and the card chrome the mesh tab uses', () => {
    // Those carry meaning only when comparing machines side by side. This
    // dialog is a label/value list about one session, so importing them would
    // be borrowing a layout that does not apply.
    expect(dialogSource).not.toContain('formatQuotaFreshness')
    expect(dialogSource).not.toContain('quotaFreshnessHint')
    expect(dialogSource).not.toContain('machinesQuota')
    expect(dialogSource).not.toContain('quotaNotCollected')
  })

  it('imports quota helpers only from utils/quota-format', () => {
    expect(dialogSource).toContain("from '../../utils/quota-format'")
    expect(dialogSource).not.toContain('MeshObservabilitySurface')
    expect(dialogSource).not.toContain('meshSurfaceHelpers')
  })

  it('types quota from the mesh-shared leaf, type-only', () => {
    // web-core ships to the browser: a VALUE import from the daemon-core barrel
    // drags Node builtins in and breaks the dashboard.
    expect(dialogSource).toContain("import type { MeshNodeFactsProviderQuota } from '@adhdev/mesh-shared'")
  })
})
