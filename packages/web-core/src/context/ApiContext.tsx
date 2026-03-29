/**
 * ApiContext — Context for injecting API client into components
 *
 * standalone: createApiClient({ baseUrl: 'http://localhost:3847' })
 * cloud: createApiClient({ baseUrl, getToken, onUnauthorized })
 */
import { createContext, useContext, type ReactNode } from 'react'
import { createApiClient, type ApiClient } from '../base-api'

const defaultClient = createApiClient({ baseUrl: 'http://localhost:3847' })

const ApiCtx = createContext<ApiClient>(defaultClient)

export function ApiProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
    return <ApiCtx.Provider value={client}>{children}</ApiCtx.Provider>
}

export function useApi(): ApiClient {
    return useContext(ApiCtx)
}
