import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cursorMcpAllowEntries, ensureCursorMcpToolAllow, isMcpToolAllowDeclared } from '../../src/mesh/mcp-tool-allow.js'

describe('ensureCursorMcpToolAllow (cursor "Run this MCP tool?" pre-approval)', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-allow-')) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it('declaration gate', () => {
    expect(isMcpToolAllowDeclared({ format: 'cursor_cli_permissions' })).toBe(true)
    expect(isMcpToolAllowDeclared({ format: 'other' })).toBe(false)
    expect(isMcpToolAllowDeclared(undefined)).toBe(false)
  })

  it('wildcards the whole server, nothing else', () => {
    expect(cursorMcpAllowEntries(['adhdev-assistant', ' '])).toEqual(['Mcp(adhdev-assistant:*)'])
  })

  it('workspace MCP config → project .cursor/cli.json, created with allow entry', () => {
    const ws = path.join(root, 'ws')
    const mcp = path.join(ws, '.cursor', 'mcp.json')
    const out = ensureCursorMcpToolAllow({ mcpConfigPath: mcp, workspace: ws, serverNames: ['adhdev-assistant'] })
    expect(out).toBe(path.join(ws, '.cursor', 'cli.json'))
    expect(JSON.parse(fs.readFileSync(out!, 'utf8')).permissions.allow).toEqual(['Mcp(adhdev-assistant:*)'])
  })

  it('private-HOME MCP config → user .cursor/cli-config.json, merged, idempotent, other entries kept', () => {
    const ws = path.join(root, 'ws')
    const home = path.join(root, 'home')
    const mcp = path.join(home, '.cursor', 'mcp.json')
    const target = path.join(home, '.cursor', 'cli-config.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify({ editor: { vimMode: true }, permissions: { allow: ['Shell(ls)'], deny: ['Shell(rm)'] } }))
    const run = () => ensureCursorMcpToolAllow({ mcpConfigPath: mcp, workspace: ws, serverNames: ['adhdev-worker'] })
    expect(run()).toBe(target)
    expect(run()).toBe(target)
    const cfg = JSON.parse(fs.readFileSync(target, 'utf8'))
    expect(cfg.editor).toEqual({ vimMode: true })
    expect(cfg.permissions).toEqual({ allow: ['Shell(ls)', 'Mcp(adhdev-worker:*)'], deny: ['Shell(rm)'] })
  })

  it('leaves an unparseable permissions file alone and never throws', () => {
    const ws = path.join(root, 'ws')
    const target = path.join(ws, '.cursor', 'cli.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '{ not json')
    expect(ensureCursorMcpToolAllow({ mcpConfigPath: path.join(ws, '.cursor', 'mcp.json'), workspace: ws, serverNames: ['x'] })).toBeNull()
    expect(fs.readFileSync(target, 'utf8')).toBe('{ not json')
  })
})
