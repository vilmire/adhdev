// Desktop notification copy (UI simplification 2026-09-27): the title is the
// agent's name and the body one short localized line — never the old English
// "<emoji> <name> — Task complete" + "Agent has finished generating" pair — and
// the in-app completion toast formats its duration instead of raw seconds.
import { afterEach, describe, expect, it } from 'vitest'
import { i18next } from '../../src/i18n/config'
import { buildBrowserNotificationContent } from '../../src/hooks/useBrowserNotifications'
import { formatDurationLocalized } from '../../src/utils/time'
import en from '../../src/i18n/locales/en/common.json'
import ko from '../../src/i18n/locales/ko/common.json'
import ja from '../../src/i18n/locales/ja/common.json'
import zhCN from '../../src/i18n/locales/zh-CN/common.json'
import es from '../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

const base = { name: 'Claude Code', onApproval: true, onComplete: true, onError: true, questionEntered: false }

describe('browser notification content', () => {
    afterEach(async () => { await i18next.changeLanguage('en') })

    it('title is the agent name; body is one short localized line', () => {
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'idle' }))
            .toEqual({ kind: 'complete', title: 'Claude Code', body: 'Finished' })
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'waiting_approval', modalMessage: 'Run   rm -rf build/?' }))
            .toEqual({ kind: 'approval', title: 'Claude Code', body: 'Needs approval: Run rm -rf build/?' })
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'waiting_approval' }))
            .toEqual({ kind: 'approval', title: 'Claude Code', body: 'Needs approval' })
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'waiting_choice', questionEntered: true, modalMessage: 'Which branch?' }))
            .toEqual({ kind: 'question', title: 'Claude Code', body: 'Question: Which branch?' })
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'error' }))
            .toEqual({ kind: 'error', title: 'Claude Code', body: 'Stopped with an error' })
    })

    it('stays silent for non-transitions and disabled categories', () => {
        expect(buildBrowserNotificationContent({ ...base, prev: 'idle', curr: 'idle' })).toBeNull()
        expect(buildBrowserNotificationContent({ ...base, prev: 'waiting_approval', curr: 'waiting_approval' })).toBeNull()
        expect(buildBrowserNotificationContent({ ...base, onComplete: false, prev: 'generating', curr: 'idle' })).toBeNull()
    })

    it('follows the dashboard language', async () => {
        await i18next.changeLanguage('ko')
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'idle' })?.body).toBe('완료됨')
        expect(buildBrowserNotificationContent({ ...base, prev: 'generating', curr: 'waiting_approval', modalMessage: 'git push' })?.body).toBe('승인 필요: git push')
    })

    it('every locale ships the notification strings and a unit-free duration template', () => {
        for (const [name, locale] of Object.entries(LOCALES)) {
            for (const key of ['question', 'questionWithMessage', 'approval', 'approvalWithMessage', 'finished', 'error']) {
                expect(locale.event.browser[key], `${name} event.browser.${key}`).toBeTruthy()
            }
            const template: string = locale.event.taskCompletedWithDuration
            expect(template, `${name} taskCompletedWithDuration`).toContain('{{duration}}')
            // The unit comes from the formatter now, so no hard-coded seconds suffix.
            expect(template).not.toMatch(/\{\{duration\}\}\s?(s|초|秒|\s秒)/)
        }
    })

    it('formats task durations instead of raw seconds', () => {
        expect(formatDurationLocalized(45_000, { locale: 'en' })).toBe('45 sec')
        expect(formatDurationLocalized(12 * 60_000, { locale: 'en' })).toBe('12 min')
        expect(formatDurationLocalized((3 * 60 + 5) * 60_000, { locale: 'en' })).toBe('3 hr 5 min')
        expect(formatDurationLocalized(12 * 60_000, { locale: 'ko' })).toBe('12분')
        expect(i18next.t('event.taskCompletedWithDuration', { label: 'devbox', duration: formatDurationLocalized(754_000, { locale: 'en' }) }))
            .toBe('devbox agent task completed (12 min)')
    })
})
