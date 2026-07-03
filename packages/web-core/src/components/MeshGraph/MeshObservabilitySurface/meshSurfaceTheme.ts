import { createContext } from 'react'
import { getMeshGraphTheme } from '../meshGraphTheme'

// Shared theme context for the observability surface and its extracted
// subcomponents (Badge / Row / status-tab cards). Kept in its own module so the
// context identity is stable and importable across the split-out files without a
// circular dependency back into MeshObservabilitySurface.tsx.
export const MeshGraphThemeContext = createContext(getMeshGraphTheme('dark'))
