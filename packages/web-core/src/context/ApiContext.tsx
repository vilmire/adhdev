/**
 * ApiContext — Context for injecting API client into components
 *
 * standalone: createApiClient({ baseUrl: '' }) — same-origin (App.tsx)
 * cloud: does not install a provider today; any future `useApi()` consumer in
 * shared web-core code must fail loudly there rather than silently issuing
 * cross-origin requests to localhost:3847 — the USER'S OWN MACHINE — which is
 * what the old real-client default did (fragmentation audit). Mirrors the
 * TransportContext throwing-default pattern.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { type ApiClient } from '../base-api'

const defaultClient = new Proxy({} as ApiClient, {
    get(_target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined
        return () => { throw new Error(`ApiProvider not installed — cannot call ApiClient.${String(prop)}(). Wrap this tree in <ApiProvider client={...}>.`) }
    },
})

const ApiCtx = createContext<ApiClient>(defaultClient)

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
    return <ApiCtx.Provider value={client}>{children}</ApiCtx.Provider>
}

export function useApi(): ApiClient {
    return useContext(ApiCtx)
}
