// 2026-10-02: every tool bubble showed the raw input JSON
// (`↗ Bash: {"command":"rm -rf dist","description":"Delete dist"}`).
import { describe, expect, it } from 'vitest'
import { formatToolCallArgs, projectToolBlock } from '../../../src/providers/spec/native-history-tool-blocks.js'

describe('formatToolCallArgs', () => {
  it('shows the command and its description for Bash', () => {
    expect(formatToolCallArgs({ command: 'rm -rf dist', description: 'Delete dist folder', timeout: 120000 }))
      .toBe('rm -rf dist — Delete dist folder')
  })

  it('shows the path for file tools', () => {
    expect(formatToolCallArgs({ file_path: '/repo/src/main.ts', limit: 40 })).toBe('/repo/src/main.ts')
  })

  it('shows key=value pairs when there is no primary field', () => {
    expect(formatToolCallArgs({ node_id: 'node_1', execute: true, tags: ['a'] })).toBe('node_id=node_1 execute=true tags=["a"]')
  })

  it('passes strings through', () => {
    expect(formatToolCallArgs('ls -la')).toBe('ls -la')
  })
})

describe('projectToolBlock', () => {
  it('renders a readable Bash call bubble', () => {
    const msg = projectToolBlock({ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }, {})
    expect(msg?.content).toBe('↗ Bash: npm test — Run tests')
  })
})
