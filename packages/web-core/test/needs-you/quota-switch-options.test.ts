import { describe, expect, it } from 'vitest'
import enCommon from '../../src/i18n/locales/en/common.json'
import jaCommon from '../../src/i18n/locales/ja/common.json'
import { localizeConfirmation, localizeQuotaOption } from '../../src/components/needs-you/DecisionCard'
import { parseNeedsYouList } from '../../src/components/needs-you/needs-you-model'

const tFor = (dict: any) => ((key: string, vars?: Record<string, string>) => {
    const v = key.split('.').reduce((o: any, k) => o?.[k], dict) as string
    return vars ? v.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k]) : v
}) as any

describe('quota decision options in the needs-you card', () => {
    it('localizes the daemon labels and keeps the provider id in "Switch to <cli>"', () => {
        const en = tFor(enCommon), ja = tFor(jaCommon)
        expect(localizeQuotaOption(en, 'Switch to codex-cli')).toBe('Switch to codex-cli')
        expect(localizeQuotaOption(ja, 'Switch to codex-cli')).toBe('codex-cli に切り替える')
        expect(localizeQuotaOption(ja, 'Wait for reset')).toBe('リセットまで待つ')
        expect(localizeQuotaOption(ja, 'Switch to $(rm -rf)')).toBe('Switch to $(rm -rf)') // not a provider id: passes through
        const d = localizeConfirmation(ja, { question: 'q', options: [{ id: 'a', label: 'Wait for reset' }, { id: 'b', label: 'Switch to kimi' }] }, false)
        expect(d.options.map(o => o.label)).toEqual(['リセットまで待つ', 'kimi に切り替える'])
    })

    it('carries the decision revision so the answer can echo it', () => {
        const snap = parseNeedsYouList({ success: true, ownerDecisions: [{ meshId: 'm', itemId: 'i', question: 'q', options: [], revision: 2 }] }, 'd1')
        expect(snap.decisions[0].revision).toBe(2)
    })
})
