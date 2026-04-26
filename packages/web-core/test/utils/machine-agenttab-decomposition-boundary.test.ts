import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('machine AgentTab decomposition boundary', () => {
  it('keeps workspace selector rendering in a dedicated pure component while AgentTab owns state', () => {
    const agentTabSource = readSource('pages/machine/AgentTab.tsx')
    const workspaceSelectorSource = readSource('pages/machine/AgentWorkspaceSelector.tsx')

    expect(agentTabSource).toContain("import AgentWorkspaceSelector from './AgentWorkspaceSelector'")
    expect(agentTabSource).not.toContain('const workspaceSelector = (')
    expect(agentTabSource).toContain('<AgentWorkspaceSelector')

    expect(workspaceSelectorSource).not.toContain('sendDaemonCommand')
    expect(workspaceSelectorSource).not.toMatch(/\buse[A-Z][A-Za-z]+\s*\(/)
  })
})
