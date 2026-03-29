import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import StandaloneApp from './App'
// import '@adhdev/web-core/src/index.css'  // TODO: enable after CSS migration

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <StandaloneApp />
    </StrictMode>
)
