// @vitest-environment jsdom
//
// (O5) The chat activity-row preference must have a WRITER again. The original
// toggle was removed in 1b8f6d03 while the preference readers stayed behind, so
// activity rows became permanently hidden for every user ("recorder zero").
// This file guards both restored writers end-to-end against the REAL
// localStorage preference, plus the same-document change event that lets a
// Settings flip reach already-mounted ChatPanes.
//
// INJECTION CHECK: deleting the ChatActivitySection ToggleRow, dropping the
// setChatActivityVisiblePreference call, removing the ChatPane pill button,
// or dropping a locale key turns this red.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ChatActivitySection } from '../../../src/components/settings/ChatActivitySection'
import {
  CHAT_ACTIVITY_VISIBILITY_EVENT,
  CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY,
  mergeChatAndActivityMessages,
  readChatActivityVisiblePreference,
  setChatActivityVisiblePreference,
  subscribeChatActivityVisiblePreference,
} from '../../../src/components/dashboard/chat-activity-visibility'
import type { ChatMessage } from '@adhdev/daemon-core'

import en from '../../../src/i18n/locales/en/common.json'
import ko from '../../../src/i18n/locales/ko/common.json'
import ja from '../../../src/i18n/locales/ja/common.json'
import zhCN from '../../../src/i18n/locales/zh-CN/common.json'
import es from '../../../src/i18n/locales/es/common.json'

const LOCALES: Record<string, any> = { en, ko, ja, 'zh-CN': zhCN, es }

describe('chat activity toggle (O5)', () => {
  let container: HTMLDivElement
  let root: Root
  let savedStorage: unknown
  let values: Map<string, string>

  beforeEach(() => {
    // test/setup.ts replaces localStorage with a no-op stub (language pin).
    // These tests are ABOUT persistence, so install a functional in-memory
    // Storage for their duration, keeping the 'lang' → 'en' pin intact.
    savedStorage = (globalThis as { localStorage?: unknown }).localStorage
    values = new Map<string, string>([['lang', 'en']])
    ;(globalThis as { localStorage?: Partial<Storage> }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ;(globalThis as { localStorage?: unknown }).localStorage = savedStorage as Storage
  })

  it('defaults to hidden — absent preference reads false', () => {
    expect(readChatActivityVisiblePreference()).toBe(false)
  })

  it('Settings toggle records the preference and the recorded value changes activity-row display', () => {
    act(() => root.render(<ChatActivitySection />))
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.getAttribute('aria-checked')).toBe('false')

    act(() => toggle!.click())

    // The preference is actually recorded…
    expect(values.get(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY)).toBe('1')
    expect(toggle!.getAttribute('aria-checked')).toBe('true')

    // …and the recorded value flips what the transcript merge renders.
    const chat = [{ role: 'assistant', content: 'answer', receivedAt: 20 } as ChatMessage]
    const activity = [{ role: 'assistant', kind: 'tool', content: 'tool row', receivedAt: 10 } as ChatMessage]
    expect(
      mergeChatAndActivityMessages(chat, activity, readChatActivityVisiblePreference()).map((m) => m.content),
    ).toEqual(['tool row', 'answer'])

    act(() => toggle!.click())
    expect(values.get(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY)).toBe('0')
    expect(mergeChatAndActivityMessages(chat, activity, readChatActivityVisiblePreference())).toEqual(chat)
  })

  it('setter notifies same-document subscribers — storage events alone never fire in the writing tab', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeChatActivityVisiblePreference((visible) => seen.push(visible))

    setChatActivityVisiblePreference(true)
    setChatActivityVisiblePreference(false)
    expect(seen).toEqual([true, false])

    unsubscribe()
    setChatActivityVisiblePreference(true)
    expect(seen).toEqual([true, false])
  })

  it('subscriber also follows cross-tab storage events', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeChatActivityVisiblePreference((visible) => seen.push(visible))
    values.set(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY, "1")
    window.dispatchEvent(new StorageEvent('storage', { key: CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY, newValue: '1' }))
    expect(seen).toEqual([true])
    unsubscribe()
  })

  it('Settings section listens for external preference flips (in-pane pill stays in sync)', () => {
    act(() => root.render(<ChatActivitySection />))
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    act(() => setChatActivityVisiblePreference(true))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('ChatPane has a preference writer again and feeds the value to the transcript', () => {
    // jsdom overrides the URL global, so build the path with node:path instead
    // of fileURLToPath(new URL(...)) like the node-env source-slice tests do.
    const source = readFileSync(join(import.meta.dirname, '../../../src/components/dashboard/ChatPane.tsx'), 'utf8')
    // The pill toggle writes through the shared setter (custom event included),
    // not a bare localStorage write that mounted panes would never observe.
    expect(source).toContain('setChatActivityVisiblePreference(next)')
    expect(source).toContain('subscribeChatActivityVisiblePreference')
    expect(source).toContain('className={`chat-activity-toggle ')
    expect(source).toContain('showActivityMessages={showActivityMessages}')
  })

  it('AppearanceSettingsSection actually mounts the toggle', () => {
    const source = readFileSync(join(import.meta.dirname, '../../../src/components/settings/AppearanceSettingsSection.tsx'), 'utf8')
    expect(source).toContain('<ChatActivitySection />')
  })

  it('ships every locale string for both toggle surfaces', () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      expect(locale.chatPane.activityToggleLabel, `${name} chatPane.activityToggleLabel`).toBeTruthy()
      expect(locale.chatPane.activityToggleTitle, `${name} chatPane.activityToggleTitle`).toBeTruthy()
      expect(locale.settings.appearance.chatLabel, `${name} settings.appearance.chatLabel`).toBeTruthy()
      expect(locale.settings.chatActivity.rowLabel, `${name} settings.chatActivity.rowLabel`).toBeTruthy()
      expect(locale.settings.chatActivity.descriptionOn, `${name} settings.chatActivity.descriptionOn`).toBeTruthy()
      expect(locale.settings.chatActivity.descriptionOff, `${name} settings.chatActivity.descriptionOff`).toBeTruthy()
    }
  })

  it('same-document event name stays namespaced and stable', () => {
    expect(CHAT_ACTIVITY_VISIBILITY_EVENT).toBe('adhdev:chat-activity-visibility-change')
  })
})
