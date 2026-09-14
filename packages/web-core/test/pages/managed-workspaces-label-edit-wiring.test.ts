import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('source wiring — mesh gate + workspace_set_label action', () => {
    it('ManagedWorkspacesSection only mounts the editor behind canEditWorkspaceLabel', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../../src/pages/machine/ManagedWorkspacesSection.tsx', import.meta.url)),
            'utf8',
        )
        expect(src).toMatch(/canEditWorkspaceLabel\(w\.path, meshWorkspacePaths\)/)
        expect(src).toMatch(/<WorkspaceLabelEditor/)
        expect(src).toMatch(/onSave=\{handleWorkspaceSetLabel\}/)
    })

    it('useMachineActions sends workspace_set_label then reloads via workspace_list', () => {
        const src = readFileSync(
            fileURLToPath(new URL('../../src/pages/machine/useMachineActions.ts', import.meta.url)),
            'utf8',
        )
        expect(src).toMatch(/sendDaemonCommand\(machineId, 'workspace_set_label'/)
        expect(src).toMatch(/sendDaemonCommand\(machineId, 'workspace_list'/)
        const setLabelAt = src.indexOf("'workspace_set_label'")
        const listAt = src.indexOf("'workspace_list'", setLabelAt)
        expect(setLabelAt).toBeGreaterThan(0)
        expect(listAt).toBeGreaterThan(setLabelAt)
    })
})
