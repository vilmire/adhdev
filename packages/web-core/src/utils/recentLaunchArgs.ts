const RECENT_LAUNCH_ARGS_KEY = 'adhdev-recent-launch-args-v1'
const MAX_RECENT_ARGS = 8

interface RecentLaunchArgsStore {
    byKey: Record<string, { items: string[] }>
}

function normalizeArgs(value: string | null | undefined) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
}

function makeStoreKey(machineId: string, providerType: string) {
    return `${machineId.trim()}::${providerType.trim()}`
}

function readStore(): RecentLaunchArgsStore {
    if (typeof window === 'undefined') return { byKey: {} }
    try {
        const parsed = JSON.parse(window.localStorage.getItem(RECENT_LAUNCH_ARGS_KEY) || '{}') as Partial<RecentLaunchArgsStore>
        return {
            byKey: typeof parsed.byKey === 'object' && parsed.byKey ? parsed.byKey : {},
        }
    } catch {
        return { byKey: {} }
    }
}

function writeStore(store: RecentLaunchArgsStore) {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(RECENT_LAUNCH_ARGS_KEY, JSON.stringify(store))
    } catch {
        /* noop */
    }
}

export function getRecentLaunchArgs(machineId: string, providerType: string): string[] {
    const normalizedMachineId = String(machineId || '').trim()
    const normalizedProviderType = String(providerType || '').trim()
    if (!normalizedMachineId || !normalizedProviderType) return []
    const store = readStore()
    return store.byKey[makeStoreKey(normalizedMachineId, normalizedProviderType)]?.items || []
}

export function pushRecentLaunchArgs(machineId: string, providerType: string, argsText: string) {
    const normalizedMachineId = String(machineId || '').trim()
    const normalizedProviderType = String(providerType || '').trim()
    const normalizedArgs = normalizeArgs(argsText)
    if (!normalizedMachineId || !normalizedProviderType || !normalizedArgs) return

    const store = readStore()
    const key = makeStoreKey(normalizedMachineId, normalizedProviderType)
    const prev = store.byKey[key]?.items || []
    const next = [normalizedArgs, ...prev.filter(item => item !== normalizedArgs)].slice(0, MAX_RECENT_ARGS)
    store.byKey[key] = { items: next }
    writeStore(store)
}
