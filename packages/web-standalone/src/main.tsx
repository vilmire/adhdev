import { createRoot } from 'react-dom/client'
import { ErrorBoundary, setupCompat } from '@adhdev/web-core'
import StandaloneApp from './App'
import { standaloneConnectionManager } from './connection-manager'

setupCompat({
    connectionManager: standaloneConnectionManager,
})

// Same root guard web-cloud's main.tsx uses. Without it a render-time exception
// unmounts the whole tree and standalone shows a blank white page with nothing
// but a console trace. StandaloneApp owns its own BrowserRouter, so the boundary
// wraps the app itself.
createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
        <StandaloneApp />
    </ErrorBoundary>
)
