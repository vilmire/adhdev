import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetWorkerTaskTokensForTest,
  expandWorkerIsolationPlaceholders,
  expireWorkerTaskTokensForTask,
  findWorkerPrivateHomeSpec,
  isWorkerMcpEnabled,
  liveWorkerTaskTokenCount,
  mintWorkerTaskToken,
  prepareWorkerPrivateHome,
  resolveWorkerMcpConfigPath,
  resolveWorkerMcpIsolation,
  revokeWorkerTaskToken,
  verifyWorkerTaskToken,
  WORKER_TOKEN_CANARY_PREFIX,
  writeWorkerMcpConfig,
} from '../../src/mesh/worker-mcp-isolation'

const ON = { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Build a realistic fake `~/.gemini` so the antigravity spec has real sources. */
function fakeGeminiHome(): string {
  const home = tmp('adhdev-worker-realhome-')
  const agy = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(agy, { recursive: true })
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
  writeFileSync(join(agy, 'antigravity-oauth-token'), '{"token":{"access_token":"x"}}', { mode: 0o600 })
  writeFileSync(join(agy, 'settings.json'), '{"security":{}}', { mode: 0o600 })
  writeFileSync(join(agy, 'history.jsonl'), '', { mode: 0o600 })
  mkdirSync(join(agy, 'brain'), { recursive: true })
  mkdirSync(join(agy, 'conversations'), { recursive: true })
  // The coordinator's own MCP config — the thing being isolated away.
  writeFileSync(
    join(home, '.gemini', 'config', 'mcp_config.json'),
    JSON.stringify({ mcpServers: { 'adhdev-mesh': { command: 'adhdev', args: ['mcp', '--repo-mesh', 'mesh_coord'] } } }),
  )
  return home
}

beforeEach(() => { __resetWorkerTaskTokensForTest() })
afterEach(() => { __resetWorkerTaskTokensForTest() })

describe('worker MCP flag gate', () => {
  it('is OFF unless explicitly enabled', () => {
    expect(isWorkerMcpEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: '' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: 'false' } as NodeJS.ProcessEnv)).toBe(false)
    // A typo'd value must not accidentally enable a security-relevant feature.
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: 'yep' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('accepts the documented truthy spellings', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
      expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  it('resolves to null with the gate off — the byte-identity guarantee', () => {
    // This is THE regression that protects "gate off ⇒ nothing changes": every
    // consumer branches on this null, so a null here means no config write, no
    // private HOME, no env.set application anywhere downstream.
    const result = resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace: tmp('adhdev-ws-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
    }, {} as NodeJS.ProcessEnv)
    expect(result).toBeNull()
  })

  it('writes nothing to disk with the gate off', () => {
    const workspace = tmp('adhdev-ws-off-')
    resolveWorkerMcpIsolation({
      providerType: 'kimi',
      workspace,
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json' },
    }, {} as NodeJS.ProcessEnv)
    expect(existsSync(join(workspace, '.kimi-code', 'mcp.json'))).toBe(false)
  })
})

describe('worker task token minting', () => {
  it('mints an opaque token bound to the full identity tuple', () => {
    const minted = mintWorkerTaskToken({
      meshId: 'mesh_a', taskId: 'task_1', attemptId: 'att_1', sessionId: 'sess_1', nodeId: 'node_1',
    })
    expect(minted.token.startsWith(WORKER_TOKEN_CANARY_PREFIX)).toBe(true)
    // 32 random bytes base64url — long enough that guessing is not a threat.
    expect(minted.token.length).toBeGreaterThan(40)
    expect(verifyWorkerTaskToken(minted.token)).toMatchObject({
      meshId: 'mesh_a', taskId: 'task_1', attemptId: 'att_1', sessionId: 'sess_1', nodeId: 'node_1',
    })
  })

  it('mints unique secrets per call', () => {
    const a = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1' })
    const b = mintWorkerTaskToken({ meshId: 'm', taskId: 't2', attemptId: 'a1' })
    expect(a.token).not.toBe(b.token)
  })

  it('fails closed for an unknown, empty or non-string token', () => {
    expect(verifyWorkerTaskToken('wtk_nope')).toBeNull()
    expect(verifyWorkerTaskToken('')).toBeNull()
    expect(verifyWorkerTaskToken(undefined)).toBeNull()
    expect(verifyWorkerTaskToken(null)).toBeNull()
    expect(verifyWorkerTaskToken(42)).toBeNull()
  })

  it('requires both meshId and taskId', () => {
    expect(() => mintWorkerTaskToken({ meshId: '', taskId: 't' })).toThrow(/meshId and taskId/)
    expect(() => mintWorkerTaskToken({ meshId: 'm', taskId: '  ' })).toThrow(/meshId and taskId/)
  })

  it('revokes the prior token when the SAME attempt re-mints (REDRIVE-DUP)', () => {
    // A re-dispatch of one attempt must not leave the superseded worker able to
    // report — that late report is exactly the REDRIVE-DUP failure family.
    const first = mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'att_1' })
    const second = mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'att_1' })
    expect(verifyWorkerTaskToken(first.token)).toBeNull()
    expect(verifyWorkerTaskToken(second.token)).not.toBeNull()
  })

  it('keeps a retry token distinct from the original attempt token', () => {
    // Different attemptId = a genuine retry. Both exist briefly; expiry is by
    // task, so the terminal flip clears both.
    const attempt1 = mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'att_1' })
    const attempt2 = mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'att_2' })
    expect(attempt1.token).not.toBe(attempt2.token)
    expect(verifyWorkerTaskToken(attempt1.token)).not.toBeNull()
    expect(verifyWorkerTaskToken(attempt2.token)).not.toBeNull()
  })
})

describe('worker task token expiry', () => {
  it('expires every token for a task and leaves siblings alone', () => {
    const mine = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a1' })
    const retry = mintWorkerTaskToken({ meshId: 'm', taskId: 't1', attemptId: 'a2' })
    const sibling = mintWorkerTaskToken({ meshId: 'm', taskId: 't2', attemptId: 'a1' })

    expect(expireWorkerTaskTokensForTask('m', 't1')).toBe(2)
    expect(verifyWorkerTaskToken(mine.token)).toBeNull()
    expect(verifyWorkerTaskToken(retry.token)).toBeNull()
    expect(verifyWorkerTaskToken(sibling.token)).not.toBeNull()
  })

  it('is idempotent — the terminal chokepoint replays it', () => {
    // commitTaskTerminalAndAdvanceGraph re-enters with duplicate:true for an
    // already-terminal row, so this hook MUST tolerate repeat calls.
    mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'a' })
    expect(expireWorkerTaskTokensForTask('m', 't')).toBe(1)
    expect(expireWorkerTaskTokensForTask('m', 't')).toBe(0)
    expect(expireWorkerTaskTokensForTask('m', 't')).toBe(0)
  })

  it('does not leak map entries once every token for a task is expired', () => {
    mintWorkerTaskToken({ meshId: 'm', taskId: 't', attemptId: 'a' })
    expect(liveWorkerTaskTokenCount()).toBe(1)
    expireWorkerTaskTokensForTask('m', 't')
    expect(liveWorkerTaskTokenCount()).toBe(0)
  })

  it('revokes a single token by secret', () => {
    const minted = mintWorkerTaskToken({ meshId: 'm', taskId: 't' })
    expect(revokeWorkerTaskToken(minted.token)).toBe(true)
    expect(revokeWorkerTaskToken(minted.token)).toBe(false)
  })
})

describe('worker MCP config path resolution', () => {
  it('resolves a repo-local path against the workspace', () => {
    expect(resolveWorkerMcpConfigPath('.kimi-code/mcp.json', '/ws')).toBe(join('/ws', '.kimi-code/mcp.json'))
  })

  it('resolves `~` against the WORKER home, not the real home', () => {
    // This single substitution is what makes a home-rooted provider isolable —
    // the coordinator resolver has no such seam.
    const resolved = resolveWorkerMcpConfigPath('~/.gemini/config/mcp_config.json', '/ws', '/tmp/worker-home')
    expect(resolved).toBe(join('/tmp/worker-home', '.gemini/config/mcp_config.json'))
  })

  it('passes an absolute path through untouched', () => {
    expect(resolveWorkerMcpConfigPath('/etc/mcp.json', '/ws', '/tmp/wh')).toBe('/etc/mcp.json')
  })
})

describe('writeWorkerMcpConfig', () => {
  it('writes an empty server map for a repo-local provider', () => {
    const workspace = tmp('adhdev-ws-write-')
    const written = writeWorkerMcpConfig({
      declaredPath: '.kimi-code/mcp.json',
      format: 'claude_mcp_json',
      serverName: 'adhdev-mesh',
      workspace,
    })
    expect(JSON.parse(readFileSync(written, 'utf-8'))).toEqual({ mcpServers: {} })
  })

  it('uses the format-specific server key', () => {
    const workspace = tmp('adhdev-ws-fmt-')
    const written = writeWorkerMcpConfig({
      declaredPath: 'opencode.json', format: 'opencode_json', serverName: 'adhdev-mesh', workspace,
    })
    expect(JSON.parse(readFileSync(written, 'utf-8'))).toEqual({ mcp: {} })
  })

  it('carries the token in the server entry env when a server is supplied', () => {
    const workspace = tmp('adhdev-ws-token-')
    const written = writeWorkerMcpConfig({
      declaredPath: '.mcp.json',
      format: 'claude_mcp_json',
      serverName: 'adhdev-worker',
      workspace,
      server: { command: 'adhdev', args: ['mcp', '--mode', 'worker'] },
      token: 'wtk_test',
    })
    const parsed = JSON.parse(readFileSync(written, 'utf-8'))
    expect(parsed.mcpServers['adhdev-worker'].env).toEqual({ ADHDEV_WORKER_TASK_TOKEN: 'wtk_test' })
  })

  it('REFUSES a home-rooted write without a private HOME', () => {
    // Writing `~/.gemini/config/mcp_config.json` with the real home would
    // clobber the coordinator's own config and break the coordinator.
    expect(() => writeWorkerMcpConfig({
      declaredPath: '~/.gemini/config/mcp_config.json',
      format: 'claude_mcp_json',
      serverName: 'adhdev-mesh',
      workspace: tmp('adhdev-ws-refuse-'),
    })).toThrow(/home_rooted_without_private_home/)
  })

  it('rejects an unsupported format rather than writing a file the CLI cannot read', () => {
    expect(() => writeWorkerMcpConfig({
      declaredPath: 'x.json',
      format: 'not_a_format' as any,
      serverName: 's',
      workspace: tmp('adhdev-ws-badfmt-'),
    })).toThrow(/unsupported_format/)
  })
})

describe('antigravity worker-private HOME', () => {
  it('declares a spec only for antigravity in Phase A', () => {
    expect(findWorkerPrivateHomeSpec('antigravity-cli')).not.toBeNull()
    // hermes is deferred by owner decision §12-3; the rest are repo-local.
    for (const other of ['hermes-cli', 'claude-cli', 'codex-cli', 'cursor-cli', 'grok-cli', 'kimi', 'opencode']) {
      expect(findWorkerPrivateHomeSpec(other)).toBeNull()
    }
  })

  it('symlinks the auth surface so a token refresh stays visible', () => {
    const realHome = fakeGeminiHome()
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-'),
    })

    const token = join(prepared.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    expect(lstatSync(token).isSymbolicLink()).toBe(true)
    expect(realpathSync(token)).toBe(realpathSync(join(realHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')))
    // A refresh written through the real path must be visible to the worker.
    writeFileSync(join(realHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'refreshed', { mode: 0o600 })
    expect(readFileSync(token, 'utf-8')).toBe('refreshed')
  })

  it('★links the transcript surfaces through to the real home', () => {
    // The daemon reads transcripts from os.homedir() (hard-coded in
    // native-history/antigravity-cli-transcript.ts). If the worker wrote them
    // into an isolated tempdir instead, every antigravity session would report
    // zero assistant messages. These links are what prevent that.
    const realHome = fakeGeminiHome()
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy2-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase2-'),
    })

    for (const surface of ['brain', 'conversations', 'history.jsonl']) {
      const linked = join(prepared.home, '.gemini', 'antigravity-cli', surface)
      expect(lstatSync(linked).isSymbolicLink()).toBe(true)
      expect(realpathSync(linked)).toBe(realpathSync(join(realHome, '.gemini', 'antigravity-cli', surface)))
    }

    // A transcript the worker writes through its private HOME must land where
    // the daemon actually looks.
    writeFileSync(join(prepared.home, '.gemini', 'antigravity-cli', 'brain', 'probe.txt'), 'from-worker')
    expect(readFileSync(join(realHome, '.gemini', 'antigravity-cli', 'brain', 'probe.txt'), 'utf-8')).toBe('from-worker')
  })

  it('★keeps .gemini/config PRIVATE — the coordinator config is not inherited', () => {
    const realHome = fakeGeminiHome()
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy3-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase3-'),
    })

    const workerConfigDir = join(prepared.home, '.gemini', 'config')
    expect(existsSync(workerConfigDir)).toBe(true)
    expect(lstatSync(workerConfigDir).isSymbolicLink()).toBe(false)
    // The coordinator's 60-tool entry must NOT be reachable from here.
    expect(existsSync(join(workerConfigDir, 'mcp_config.json'))).toBe(false)
  })

  it('gives two workers on one workspace DIFFERENT private homes', () => {
    const realHome = fakeGeminiHome()
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const workspace = tmp('adhdev-ws-shared-')
    const baseDir = tmp('adhdev-whbase4-')
    const a = prepareWorkerPrivateHome(spec, { workspace, sessionKey: 'task_1', realHome, baseDir })
    const b = prepareWorkerPrivateHome(spec, { workspace, sessionKey: 'task_2', realHome, baseDir })
    expect(a.home).not.toBe(b.home)
  })

  it('is re-runnable for the same key (relaunch replaces stale links)', () => {
    const realHome = fakeGeminiHome()
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const args = { workspace: tmp('adhdev-ws-rerun-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase5-') }
    const first = prepareWorkerPrivateHome(spec, args)
    expect(() => prepareWorkerPrivateHome(spec, args)).not.toThrow()
    expect(prepareWorkerPrivateHome(spec, args).home).toBe(first.home)
  })

  it('refuses to import a credential whose source is not owner-only', () => {
    const realHome = fakeGeminiHome()
    chmodSync(join(realHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 0o644)
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    expect(() => prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-perm-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase6-'),
    })).toThrow(/insecure_source/)
  })

  it('errors when the required auth file is absent', () => {
    const realHome = tmp('adhdev-noauth-')
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    expect(() => prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-noauth-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase7-'),
    })).toThrow(/missing_required_import/)
  })

  it('skips optional imports that do not exist yet', () => {
    const realHome = fakeGeminiHome()
    // A machine that has authed but never run a session yet.
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const stripped = { ...spec, imports: spec.imports.filter((i) => !i.relativePath.endsWith('history.jsonl')) }
    const prepared = prepareWorkerPrivateHome(
      { ...stripped, imports: [...stripped.imports, { relativePath: join('.gemini', 'nope.json'), mode: 'symlink' as const }] },
      { workspace: tmp('adhdev-ws-skip-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase8-') },
    )
    expect(prepared.skipped).toContain(join('.gemini', 'nope.json'))
  })
})

describe('resolveWorkerMcpIsolation (gate ON)', () => {
  it('covers a repo-local provider by writing a worker config', () => {
    const workspace = tmp('adhdev-ws-on-kimi-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'kimi',
      workspace,
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json' },
    }, ON)

    expect(result).not.toBeNull()
    expect(result!.configPath).toBe(join(workspace, '.kimi-code', 'mcp.json'))
    expect(JSON.parse(readFileSync(result!.configPath!, 'utf-8'))).toEqual({ mcpServers: {} })
  })

  it('covers antigravity via its private HOME and leaves the real config intact', () => {
    const realHome = fakeGeminiHome()
    const workspace = tmp('adhdev-ws-on-agy-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace,
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
      realHome,
      baseDir: tmp('adhdev-whbase9-'),
    }, ON)

    expect(result!.workerHome).toBeTruthy()
    expect(result!.configPath).toBe(join(result!.workerHome!, '.gemini', 'config', 'mcp_config.json'))
    expect(JSON.parse(readFileSync(result!.configPath!, 'utf-8'))).toEqual({ mcpServers: {} })

    // ★The coordinator's real config must be byte-untouched.
    const coordinator = JSON.parse(readFileSync(join(realHome, '.gemini', 'config', 'mcp_config.json'), 'utf-8'))
    expect(coordinator.mcpServers['adhdev-mesh']).toBeTruthy()
  })

  it('refuses to write hermes (home-rooted, no private HOME in Phase A)', () => {
    const result = resolveWorkerMcpIsolation({
      providerType: 'hermes-cli',
      workspace: tmp('adhdev-ws-on-hermes-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'hermes_config_yaml', path: '~/.hermes/config.yaml' },
    }, ON)

    expect(result!.configPath).toBeUndefined()
    expect(result!.notes.join(' ')).toMatch(/home-rooted/)
  })

  it('skips codex (manual mode declares no config path) without erroring', () => {
    // codex's mcpConfig is `mode: manual` with a `template`, no `path` — the
    // daemon registers its server via `codex mcp add`, not by writing a file.
    // It already carries real arg-level isolation (config_override disabling
    // the mesh server), so having nothing to write here is expected, not a gap.
    const result = resolveWorkerMcpIsolation({
      providerType: 'codex-cli',
      workspace: tmp('adhdev-ws-on-codex-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh' },
    }, ON)
    expect(result!.configPath).toBeUndefined()
    expect(result!.notes.join(' ')).toMatch(/no mcpConfig\.path declared/)
  })

  it('skips a declared path whose format is not auto-import writable', () => {
    const result = resolveWorkerMcpIsolation({
      providerType: 'some-cli',
      workspace: tmp('adhdev-ws-on-badfmt-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'toml_thing', path: 'cfg.toml' },
    }, ON)
    expect(result!.configPath).toBeUndefined()
    expect(result!.notes.join(' ')).toMatch(/not auto-import writable/)
  })

  it('never throws for a provider with no declared mcpConfig', () => {
    const result = resolveWorkerMcpIsolation({
      providerType: 'some-new-cli', workspace: tmp('adhdev-ws-on-none-'), sessionKey: 'task_1',
    }, ON)
    expect(result!.configPath).toBeUndefined()
    expect(result!.notes.join(' ')).toMatch(/no mcpConfig.path declared/)
  })

  it('★covers the four repo-local auto-import providers — counted', () => {
    // Gate-authoring checklist ②: count the scanned surface, do not assume it.
    const repoLocal = [
      { providerType: 'claude-cli', path: '.mcp.json', format: 'claude_mcp_json' },
      { providerType: 'cursor-cli', path: '.cursor/mcp.json', format: 'claude_mcp_json' },
      { providerType: 'grok-cli', path: '.mcp.json', format: 'claude_mcp_json' },
      { providerType: 'kimi', path: '.kimi-code/mcp.json', format: 'claude_mcp_json' },
      { providerType: 'opencode', path: 'opencode.json', format: 'opencode_json' },
    ]
    let written = 0
    for (const provider of repoLocal) {
      const workspace = tmp(`adhdev-ws-cover-${provider.providerType}-`)
      const result = resolveWorkerMcpIsolation({
        providerType: provider.providerType,
        workspace,
        sessionKey: 'task_1',
        mcpConfig: { mode: 'auto_import', format: provider.format, path: provider.path },
      }, ON)
      if (result?.configPath && existsSync(result.configPath)) written += 1
    }
    expect(written).toBe(repoLocal.length)
  })
})

describe('{{workerHome}} placeholder expansion', () => {
  it('substitutes every occurrence', () => {
    expect(expandWorkerIsolationPlaceholders('{{workerHome}}/.gemini', { workerHome: '/tmp/wh' }))
      .toBe('/tmp/wh/.gemini')
    expect(expandWorkerIsolationPlaceholders('{{workerHome}}:{{workerHome}}', { workerHome: '/x' }))
      .toBe('/x:/x')
  })

  it('passes a value with no placeholder through verbatim', () => {
    expect(expandWorkerIsolationPlaceholders('literal', {})).toBe('literal')
  })

  it('returns null when the placeholder cannot be satisfied', () => {
    // The caller must SKIP the variable — exporting a literal `{{workerHome}}`
    // would point the CLI at a directory that does not exist.
    expect(expandWorkerIsolationPlaceholders('{{workerHome}}/x', {})).toBeNull()
  })
})
