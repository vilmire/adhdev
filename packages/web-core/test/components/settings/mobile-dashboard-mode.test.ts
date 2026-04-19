import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_DASHBOARD_MODE_KEY,
  getMobileDashboardMode,
  setMobileDashboardMode,
  subscribeMobileDashboardMode,
} from '../../../src/components/settings/MobileDashboardModeSection'

function createStorageMock() {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createStorageMock())
  const eventTarget = new EventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    localStorage,
  })
  if (typeof CustomEvent === 'undefined') {
    class CustomEventShim<T = unknown> extends Event {
      detail: T
      constructor(type: string, init?: CustomEventInit<T>) {
        super(type)
        this.detail = init?.detail as T
      }
    }
    vi.stubGlobal('CustomEvent', CustomEventShim)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('mobile dashboard mode settings', () => {
  it('notifies same-page subscribers immediately when the mode changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeMobileDashboardMode(listener)

    setMobileDashboardMode('workspace')

    expect(getMobileDashboardMode()).toBe('workspace')
    expect(listener).toHaveBeenCalledWith('workspace')
    expect(localStorage.getItem(MOBILE_DASHBOARD_MODE_KEY)).toBe('workspace')

    unsubscribe()
  })
})
