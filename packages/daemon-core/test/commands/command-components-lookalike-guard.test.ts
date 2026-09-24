/**
 * Shape guard — the command layer never hands a mesh function a
 * `DaemonComponents` look-alike (rc.39 ledger-less IPC claim class).
 *
 * Handlers used to pass `ctx.deps as any` (the S5 router deps: no turn ledger)
 * or a hand-built `{ instanceManager, router: {...} } as any` shim wherever a
 * mesh function takes `components: DaemonComponents`. A claim made through one
 * dispatched without opening its turn attempt. The real components are
 * reachable only through `ctx.components()` / the router's attached
 * components (see src/commands/daemon-components-port.ts).
 *
 * The set of guarded functions is DERIVED from src/ (every exported function
 * whose first parameter is `components: DaemonComponents`), so a new such
 * function is covered without editing this file.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../src')
const COMMANDS = path.join(SRC, 'commands')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return e.isFile() && p.endsWith('.ts') ? [p] : []
  })
}

/** The first argument of the call whose `(` is at `open`, up to the top-level `,` or `)`. */
function firstArg(src: string, open: number): string {
  let depth = 0
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return src.slice(open + 1, i).trim()
      depth -= 1
    } else if (ch === ',' && depth === 0) return src.slice(open + 1, i).trim()
  }
  return src.slice(open + 1).trim()
}

/** Strip line + block comments so prose that names a function is not a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const componentsTypedFunctions = [...new Set(walk(SRC).flatMap((file) => {
  const src = fs.readFileSync(file, 'utf8')
  return [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(\s*components\s*:\s*DaemonComponents\b/g)].map(m => m[1])
}))].sort()

// Only the real components may be passed: the S7-attached object, read via the
// accessor, or a local bound from it.
const ALLOWED_FIRST_ARGS = new Set(['ctx.components()', 'components'])

describe('command layer passes only REAL DaemonComponents to components-typed mesh functions', () => {
  const commandFiles = walk(COMMANDS)

  it('derives the guarded function set from src (non-vacuous)', () => {
    expect(componentsTypedFunctions).toEqual(expect.arrayContaining(['triggerMeshQueue', 'tryAssignQueueTask', 'handleMeshForwardEvent', 'getMeshWithCache']))
    expect(commandFiles.length).toBeGreaterThan(50)
  })

  it('every call from src/commands/** passes ctx.components() or a `components` local — never deps or a literal shim', () => {
    const calls: Array<{ file: string; fn: string; arg: string }> = []
    for (const file of commandFiles) {
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      for (const fn of componentsTypedFunctions) {
        const re = new RegExp(`(?<![A-Za-z0-9_.])${fn}\\s*\\(`, 'g')
        for (const m of src.matchAll(re)) {
          const before = src.slice(Math.max(0, m.index! - 20), m.index!)
          if (/function\s+$/.test(before)) continue
          calls.push({ file: path.relative(SRC, file), fn, arg: firstArg(src, m.index! + m[0].length - 1) })
        }
      }
    }
    // The known command-layer sites (trigger_mesh_queue ×2, mesh-graph-ipc, mesh_forward_event,
    // clone_mesh_node bootstrap emit, refine single + batch) — fewer means the scan broke.
    expect(calls.length).toBeGreaterThanOrEqual(7)
    const offenders = calls.filter(c => !ALLOWED_FIRST_ARGS.has(c.arg))
    expect(offenders).toEqual([])
  })

  it('no `deps as any` (router deps masquerading as something wider) anywhere in src/commands/**', () => {
    const offenders = commandFiles.flatMap((file) => {
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      return [...src.matchAll(/\bdeps\s*\)?\s+as\s+any\b/g)].map(m => `${path.relative(SRC, file)}: ${m[0]}`)
    })
    expect(offenders).toEqual([])
  })
})
