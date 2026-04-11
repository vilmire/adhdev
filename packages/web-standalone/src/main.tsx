import { createRoot } from 'react-dom/client'
import { setupCompat } from '@adhdev/web-core'
import StandaloneApp from './App'
import { standaloneConnectionManager } from './connection-manager'

setupCompat({
    connectionManager: standaloneConnectionManager,
})

createRoot(document.getElementById('root')!).render(
    <StandaloneApp />
)
