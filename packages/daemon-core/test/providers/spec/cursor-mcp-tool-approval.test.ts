/**
 * cursor-agent (v2026.10.22) parks on a per-call "Run this MCP tool?" prompt for
 * every ADHDev MCP tool (`--approve-mcps` only approves LOADING the server).
 * The launch half is `meshCoordinator.mcpToolAllow` (mesh/mcp-tool-allow.ts);
 * this file pins the detection safety net: the spec must read the screen as an
 * `approval` modal from every live state, expose all four options (including
 * `Reject & propose changes (p)`), and auto-approve must pick the one-time
 * "Run (once)" — never the persistent allowlist, reject or skip.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSections } from '../../../src/providers/spec/evaluator.js'
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js'
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js'
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js'
import { pickLeastPrivilegeApprovalButton } from '../../../src/providers/approval-utils.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SPEC_PATH = path.resolve(HERE, '../../../../../../adhdev-providers/cli/cursor-cli/specs/1.0.json')
const maybe = fs.existsSync(SPEC_PATH) ? describe : describe.skip
const RULE = '─'.repeat(80)
const clk = (now: number): FsmClock => ({ now, stateEnteredAt: 0, regionLastChangedAt: new Map() })

// Verbatim prompt text from a live ADHDev assistant session (cursor-agent v2026.10.22-27dcf5f).
const PROMPT = [
  ' adhdev-assistant: projects',
  '',
  ' Run this MCP tool?',
  '  → Run (once) (y)',
  '    Allowlist MCP Tool (tab)',
  '    Reject & propose changes (p)',
  '    Skip (esc or n)',
]
const SCREEN = ['  Which projects do I have?', '', '  ⠋ Running  12 tokens', '', RULE, ...PROMPT]

maybe('cursor-cli "Run this MCP tool?" approval', () => {
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))
  const state = spec.states.find((s: any) => s.id === 'approval')

  it('the spec validates', () => expect(validateFsmSpec(spec)).toEqual([]))

  it('fires → approval from every live state', () => {
    const row = SCREEN.length - 1
    for (const from of ['starting', 'idle', 'busy']) {
      const ev = evaluateFsm(spec, from, SCREEN.join('\n'), { row, col: 2 }, undefined, clk(10000))
      expect(ev.fired?.to, `from ${from}`).toBe('approval')
    }
  })

  it('exposes all four buttons and names the server:tool', () => {
    const modal = deriveModal(state, resolveSections(spec.sections, SCREEN), SCREEN.join('\n'), () => {})
    expect(modal?.buttons.map((b: any) => b.label)).toEqual([
      'Run (once)', 'Allowlist MCP Tool', 'Reject & propose changes', 'Skip',
    ])
    expect(modal?.title).toBe('Run this MCP tool?\nadhdev-assistant: projects')
  })

  it('without a box rule the title is the bare question (no mis-anchored detail)', () => {
    const bare = PROMPT.slice(2)
    const modal = deriveModal(state, resolveSections(spec.sections, bare), bare.join('\n'), () => {})
    expect(modal?.title).toBe('Run this MCP tool?')
    expect(modal?.buttons).toHaveLength(4)
  })

  it('auto-approve picks "Run (once)", never the persistent allowlist / reject / skip', () => {
    const labels = ['Run (once)', 'Allowlist MCP Tool', 'Reject & propose changes', 'Skip']
    expect(pickLeastPrivilegeApprovalButton(labels).index).toBe(0)
  })
})
