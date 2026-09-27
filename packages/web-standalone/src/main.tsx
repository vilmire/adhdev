import { createRoot } from 'react-dom/client'
import { ErrorBoundary, I18nReadyGate, LoadingSpinner, setupCompat } from '@adhdev/web-core'
import StandaloneAppRoot from './App'
import { standaloneConnectionManager } from './connection-manager'

setupCompat({
    connectionManager: standaloneConnectionManager,
})

// App's module scope ran initI18n(). Only `en` is bundled; a non-`en` catalog
// loads on demand, so hold the first paint until it is in (no English flash).
function StandaloneApp() {
    return (
        <I18nReadyGate
            fallback={(
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'var(--bg-primary)' }}>
                    <LoadingSpinner />
                </div>
            )}
        >
            <StandaloneAppRoot />
        </I18nReadyGate>
    )
}

// Same root guard web-cloud's main.tsx uses. Without it a render-time exception
// unmounts the whole tree and standalone shows a blank white page with nothing
// but a console trace. StandaloneApp owns its own BrowserRouter, so the boundary
// wraps the app itself.
createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
        <StandaloneApp />
    </ErrorBoundary>
)
