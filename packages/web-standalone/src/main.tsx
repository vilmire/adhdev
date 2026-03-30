import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setupCompat } from '@adhdev/web-core'
import StandaloneApp from './App'
import { standaloneConnectionManager } from './connection-manager'

setupCompat({
    connectionManager: standaloneConnectionManager,
    p2pManager: standaloneConnectionManager,
})

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <StandaloneApp />
    </StrictMode>
)
