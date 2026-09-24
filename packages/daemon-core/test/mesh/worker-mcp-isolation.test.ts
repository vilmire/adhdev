import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetWorkerTaskTokensForTest,
  deriveCursorWorkspaceSlug,
  deriveWorkerMcpDeliveryStatus,
  expandWorkerIsolationPlaceholders,
  expireWorkerTaskTokensForTask,
  findWorkerPrivateHomeSpec,
  isWorkerMcpEnabled,
  liveWorkerTaskTokenCount,
  mintWorkerTaskToken,
  prepareWorkerPrivateHome,
  resolvePrivateWorkerMcpConfigPath,
  resolveWorkerMcpConfigPath,
  resolveWorkerMcpIsolation,
  revokeWorkerTaskToken,
  verifyWorkerTaskToken,
  WORKER_TOKEN_CANARY_PREFIX,
  writeWorkerMcpConfig,
  type WorkerMcpIsolation,
} from '../../src/mesh/worker-mcp-isolation'

const ON = { ADHDEV_WORKER_MCP: '1' } as NodeJS.ProcessEnv
// ★Since the 2026-09-18 default flip, an EMPTY env means ON. Any case that
// needs the gate off must say so explicitly — `{}` no longer does it.
const OFF = { ADHDEV_WORKER_MCP: 'off' } as NodeJS.ProcessEnv

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Build a realistic fake `~/.gemini` so the antigravity spec has real sources.
 *
 * `cache/onboarding.json` is OPT-IN: a host that has authed but never finished
 * agy's first-run flow genuinely lacks it, and that case must still launch.
 */
function fakeGeminiHome(opts: { onboarded?: boolean } = {}): string {
  const home = tmp('adhdev-worker-realhome-')
  const agy = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(agy, { recursive: true })
  if (opts.onboarded) {
    mkdirSync(join(agy, 'cache'), { recursive: true })
    writeFileSync(
      join(agy, 'cache', 'onboarding.json'),
      JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }),
      { mode: 0o600 },
    )
  }
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
  // ★Default flipped OFF → ON on 2026-09-18 (owner approval, after the live
  // verification found 6 of 7 CLIs healthy on both delivery and isolation).
  // These cases assert the DEFAULT ITSELF rather than a proxy, because the
  // whole point of the flip is what an unconfigured daemon does.
  it('is ON when the var is unset — the default', () => {
    expect(isWorkerMcpEnabled({} as NodeJS.ProcessEnv)).toBe(true)
  })

  it('treats an empty value as unset, not as off', () => {
    // An inherited-but-blank var means "nobody chose", which is the default.
    // config/env-overrides.ts draws the same line (it only considers a key
    // explicitly set when it is a non-empty string), so the two surfaces agree.
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: '' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: '   ' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('★can still be turned OFF explicitly — the escape hatch survives the flip', () => {
    // The flip changed the default only. An operator (or a canary rolling the
    // feature back without a redeploy) must keep being able to disable it.
    for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: value } as NodeJS.ProcessEnv)).toBe(false)
    }
  })

  it('still accepts the documented truthy spellings', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
      expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: value } as NodeJS.ProcessEnv)).toBe(true)
    }
  })

  it('falls back to the default on an unrecognized value', () => {
    // The safe direction inverted with the default. While it was OFF, a typo
    // had to not ENABLE a security-relevant feature; now that it is ON, a typo
    // must not silently DISABLE every worker's isolation. Either way the
    // unrecognized value resolves to the default rather than its opposite.
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: 'yep' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isWorkerMcpEnabled({ ADHDEV_WORKER_MCP: 'disabled' } as NodeJS.ProcessEnv)).toBe(true)
  })

  it('resolves to null with the gate explicitly off — the byte-identity guarantee', () => {
    // This is THE regression that protects "gate off ⇒ nothing changes": every
    // consumer branches on this null, so a null here means no config write, no
    // private HOME, no env.set application anywhere downstream. Post-flip the
    // off state must be requested explicitly ({} now means ON).
    const result = resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace: tmp('adhdev-ws-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
    }, OFF)
    expect(result).toBeNull()
  })

  it('writes nothing to disk with the gate explicitly off', () => {
    const workspace = tmp('adhdev-ws-off-')
    resolveWorkerMcpIsolation({
      providerType: 'kimi',
      workspace,
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json' },
    }, OFF)
    expect(existsSync(join(workspace, '.kimi-code', 'mcp.json'))).toBe(false)
  })

  it('★resolves isolation by DEFAULT now — an unconfigured daemon isolates its workers', () => {
    // The consumer-level counterpart to the unit assertion above: flipping the
    // default is only meaningful if the downstream resolve actually engages
    // with no env configured at all. Asserting the flag alone would pass even
    // if a consumer still branched on an off-by-default assumption.
    const result = resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace: tmp('adhdev-ws-default-on-'),
      sessionKey: 'task_default_on',
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '~/.gemini/config/mcp_config.json' },
    }, {} as NodeJS.ProcessEnv)
    expect(result).not.toBeNull()
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

// SHARED-WORKSPACE CLOBBER (2026-09-22). A base-node worker runs in the
// coordinator's own workspace, and the worker writer REPLACES the file. Measured
// on the preview coordinator machine: repo-root `.mcp.json` held the worker entry
// at 22:57 and the coordinator entry at 23:06 — each writer erased the other, and
// the replace would also discard servers the owner keeps in that file.
describe('worker MCP config stays out of a shared workspace when the launch forces a config file', () => {
  const CLAUDE = { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json' }
  const OWNER_FILE = JSON.stringify({ mcpServers: { 'adhdev-mesh': { command: 'adhdev', args: ['mcp', '--repo-mesh', 'mesh_x'] }, mine: { command: 'my-server' } } })

  it('writes to a per-session private file and leaves the workspace .mcp.json byte-identical', () => {
    const workspace = tmp('adhdev-ws-shared-')
    const baseDir = tmp('adhdev-worker-base-')
    writeFileSync(join(workspace, '.mcp.json'), OWNER_FILE)

    const result = resolveWorkerMcpIsolation({
      providerType: 'claude-cli', workspace, sessionKey: 'sess_worker_1', mcpConfig: CLAUDE,
      forcedConfigFile: true, baseDir,
      server: { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--worker'] },
    }, ON)

    expect(readFileSync(join(workspace, '.mcp.json'), 'utf-8')).toBe(OWNER_FILE)
    expect(result?.configPath).toBeTruthy()
    expect(result!.configPath!.startsWith(baseDir)).toBe(true)
    expect(result!.configPath!.startsWith(workspace)).toBe(false)
    expect(result!.configHasServer).toBe(true)
    const written = JSON.parse(readFileSync(result!.configPath!, 'utf-8'))
    expect(Object.keys(written.mcpServers)).toEqual(['adhdev-mesh'])
    expect(written.mcpServers['adhdev-mesh'].args).toContain('--worker')
  })

  it('gives two sessions in the same workspace different files', () => {
    const workspace = tmp('adhdev-ws-shared-')
    const baseDir = tmp('adhdev-worker-base-')
    const launch = (sessionKey: string) => resolveWorkerMcpIsolation({
      providerType: 'claude-cli', workspace, sessionKey, mcpConfig: CLAUDE, forcedConfigFile: true, baseDir,
    }, ON)!.configPath
    expect(launch('sess_a')).not.toBe(launch('sess_b'))
    expect(launch('sess_a')).toBe(launch('sess_a'))
  })

  it('an auto-importing launch (no forced file) still writes where the CLI looks', () => {
    const workspace = tmp('adhdev-ws-autoimport-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'claude-cli', workspace, sessionKey: 'sess_auto', mcpConfig: CLAUDE,
    }, ON)
    expect(result?.configPath).toBe(join(workspace, '.mcp.json'))
  })

  it('never redirects a home-rooted or absolute declared path', () => {
    expect(resolvePrivateWorkerMcpConfigPath({ declaredPath: '~/.gemini/config/mcp_config.json', sessionKey: 's', forcedConfigFile: true })).toBeNull()
    expect(resolvePrivateWorkerMcpConfigPath({ declaredPath: '/etc/x/mcp.json', sessionKey: 's', forcedConfigFile: true })).toBeNull()
    expect(resolvePrivateWorkerMcpConfigPath({ declaredPath: '.mcp.json', sessionKey: 's' })).toBeNull()
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
  it('declares a spec for every provider that inherits an owner-global MCP surface', () => {
    expect(findWorkerPrivateHomeSpec('antigravity-cli')).not.toBeNull()
    // cursor joined in 2026-09-17 (its global ~/.cursor/mcp.json is merged into
    // every launch, so a workspace-scoped config alone isolates nothing).
    expect(findWorkerPrivateHomeSpec('cursor-cli')).not.toBeNull()
    // ★grok joined in 2026-09-18 for a RELATED but distinct reason: grok's
    // harness-compatibility layer imports CURSOR's (and claude's) HOME-scoped
    // config, so the owner's `~/.cursor/mcp.json` reached grok workers even
    // though grok's own store was empty. Same remedy, different read path.
    expect(findWorkerPrivateHomeSpec('grok-cli')).not.toBeNull()

    // ★2026-09-19: the remaining four. codex was the LIVE one — a codex worker
    // was observed running the owner's `node_repl` MCP server as a child
    // process, because the isolation rule disabled `adhdev-mesh` BY NAME and
    // left every other entry in `~/.codex/config.toml` intact.
    for (const joined of ['codex-cli', 'kimi', 'opencode', 'hermes-cli']) {
      expect(findWorkerPrivateHomeSpec(joined)).not.toBeNull()
    }

    // claude-cli remains the one provider needing no private root: it isolates
    // through `--strict-mcp-config`, which makes the CLI read ONLY the file the
    // daemon names. Nothing global is merged, so there is nothing to hide.
    expect(findWorkerPrivateHomeSpec('claude-cli')).toBeNull()
  })

  it('★routes each new provider through its OWN config-root variable, not HOME', () => {
    // The distinction that keeps these four cheap. Redirecting `HOME` would
    // repoint git/ssh/shell for the whole worker process tree and strand every
    // surface left outside the imports; a dedicated variable moves the config
    // root and nothing else. Each value was verified against the installed CLI.
    expect(findWorkerPrivateHomeSpec('codex-cli')!.homeEnvVar).toBe('CODEX_HOME')
    expect(findWorkerPrivateHomeSpec('kimi')!.homeEnvVar).toBe('KIMI_CODE_HOME')
    expect(findWorkerPrivateHomeSpec('opencode')!.homeEnvVar).toBe('XDG_CONFIG_HOME')
    expect(findWorkerPrivateHomeSpec('hermes-cli')!.homeEnvVar).toBe('HERMES_HOME')

    // The three HOME-rooted providers must NOT acquire one — they have no such
    // variable, which is exactly why they pay the full HOME-redirect cost.
    for (const homeRooted of ['antigravity-cli', 'cursor-cli', 'grok-cli']) {
      expect(findWorkerPrivateHomeSpec(homeRooted)!.homeEnvVar).toBeUndefined()
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

  it('★links the macOS Library/Keychains directory to the real HOME', () => {
    const realHome = fakeGeminiHome()
    const realKeychains = join(realHome, 'Library', 'Keychains')
    mkdirSync(realKeychains, { recursive: true })
    writeFileSync(join(realKeychains, 'login.keychain-db'), 'fixture-keychain')

    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const keychainImport = spec.imports.find((entry) => entry.relativePath === join('Library', 'Keychains'))
    expect(keychainImport).toMatchObject({ mode: 'symlink' })

    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy-keychain-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-keychain-'),
    })
    const workerKeychains = join(prepared.home, 'Library', 'Keychains')

    expect(lstatSync(workerKeychains).isSymbolicLink()).toBe(true)
    expect(realpathSync(workerKeychains)).toBe(realpathSync(realKeychains))
    expect(readFileSync(join(workerKeychains, 'login.keychain-db'), 'utf-8')).toBe('fixture-keychain')
    expect(prepared.imported).toContain(join('Library', 'Keychains'))
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

  it('★COPIES cache/onboarding.json so the worker never opens the first-run TUI', () => {
    // Measured 2026-08-31: without this import an agy worker sits in `starting`
    // on "Welcome to Antigravity CLI! Choose your color scheme:" (then the
    // Terms of Service screen) making zero model calls until it is reaped.
    // Private HOMEs are keyed per TASK, so every task re-onboards without it.
    const realHome = fakeGeminiHome({ onboarded: true })
    const rel = join('.gemini', 'antigravity-cli', 'cache', 'onboarding.json')
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!

    // COPY, not symlink: a worker write must not reach the user's real config.
    expect(spec.imports.find((entry) => entry.relativePath === rel)).toMatchObject({ mode: 'copy' })

    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy-onboard-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-onboard-'),
    })

    const workerFile = join(prepared.home, rel)
    expect(prepared.imported).toContain(rel)
    expect(lstatSync(workerFile).isSymbolicLink()).toBe(false)
    expect(JSON.parse(readFileSync(workerFile, 'utf-8')).onboardingComplete).toBe(true)

    // The copy is a real snapshot — a worker rewrite stays inside the private
    // HOME and cannot re-open onboarding for the real user.
    writeFileSync(workerFile, JSON.stringify({ onboardingComplete: false }))
    expect(JSON.parse(readFileSync(join(realHome, rel), 'utf-8')).onboardingComplete).toBe(true)
  })

  it('★launches fine on a host that has never completed agy onboarding (import is optional)', () => {
    // Cross-platform defence: linux/win32 hosts, and macs that have authed but
    // never run agy, have no cache/onboarding.json. That must SKIP, not throw —
    // cf. antigravity-oauth-token, whose `required: true` makes win32 workers
    // fail isolation outright.
    const realHome = fakeGeminiHome() // deliberately has no cache/ dir
    const rel = join('.gemini', 'antigravity-cli', 'cache', 'onboarding.json')
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!

    expect(spec.imports.find((entry) => entry.relativePath === rel)!.required).toBeFalsy()

    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy-noonboard-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-noonboard-'),
    })

    expect(prepared.skipped).toContain(rel)
    expect(existsSync(join(prepared.home, rel))).toBe(false)
    // The rest of the isolation still materialized.
    expect(prepared.imported).toContain(join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'))
  })

  it('★copies settings.json so worker trust cannot write through to the user store', () => {
    const realHome = fakeGeminiHome()
    const rel = join('.gemini', 'antigravity-cli', 'settings.json')
    const spec = findWorkerPrivateHomeSpec('antigravity-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-agy-trust-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-trust-'),
    })

    const workerSettings = join(prepared.home, rel)
    expect(lstatSync(workerSettings).isSymbolicLink()).toBe(false)
    writeFileSync(workerSettings, JSON.stringify({ trustedWorkspaces: ['/worker-only'] }), { mode: 0o600 })
    expect(JSON.parse(readFileSync(join(realHome, rel), 'utf-8'))).toEqual({ security: {} })
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
    const attempt = () => prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-perm-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase6-'),
    })
    // The owner-only check itself is gated off on win32 in production
    // (worker-mcp-isolation.ts: `entry.requireOwnerOnly && process.platform
    // !== 'win32'`), and deliberately so: chmod on Windows cannot express
    // POSIX group/other bits independently of the owner bit — empirically,
    // fs.statSync(...).mode collapses to 0o666 (writable) or 0o444
    // (read-only) no matter what chmod target is used (0o600, 0o644, ...),
    // so "owner-only vs group/other-readable" is not a distinction Windows
    // can report through this API. Enforcing the POSIX check anyway would
    // reject EVERY credential file on Windows (default-created files are
    // 0o666), not just loose ones. Pin the real win32 contract instead of
    // asserting a POSIX-only guarantee that does not hold there.
    if (process.platform === 'win32') {
      expect(attempt).not.toThrow()
      return
    }
    expect(attempt).toThrow(/insecure_source/)
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
    // Library/Keychains is intentionally declared without a platform guard.
    // On a host where that macOS path is absent, the generic importer skips it
    // before attempting a directory symlink or copy.
    expect(prepared.skipped).toContain(join('Library', 'Keychains'))
    expect(existsSync(join(prepared.home, 'Library', 'Keychains'))).toBe(false)
    expect(prepared.skipped).toContain(join('.gemini', 'nope.json'))
  })
})

/**
 * Build a realistic fake `~` for cursor: a personal global MCP config (the
 * thing being isolated away) plus the per-project store that the daemon's
 * transcript glob reads from.
 */
function fakeCursorHome(): string {
  const home = tmp('adhdev-cursor-realhome-')
  mkdirSync(join(home, '.cursor'), { recursive: true })
  // The owner's personal global servers. cursor UNIONS this into every launch,
  // which is how 50 of them reached a worker that declared none.
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } }),
  )
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true })
  writeFileSync(join(home, 'Library', 'Keychains', 'login.keychain-db'), 'fixture-keychain')
  return home
}

/**
 * The slug cursor derives for `workspace`, written out independently of the
 * implementation so these tests pin the MEASURED rule rather than agreeing with
 * whatever the source currently does: collapse runs of non-alphanumerics to one
 * dash, trim the ends.
 */
function cursorSlug(workspace: string): string {
  return realpathSync(workspace).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

describe('cursor worker-private HOME', () => {
  it('★the owner\'s global ~/.cursor/mcp.json is NOT visible from the worker HOME', () => {
    // The whole reason cursor needs a private HOME. cursor merges the global
    // config into every launch, so a workspace-scoped worker config alone left
    // the worker holding the owner's personal servers.
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const workspace = tmp('adhdev-ws-cursor-global-')
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace, sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-global-'),
    })

    // Present in the real home...
    expect(existsSync(join(realHome, '.cursor', 'mcp.json'))).toBe(true)
    // ...and unreachable from the worker's.
    expect(existsSync(join(prepared.home, '.cursor', 'mcp.json'))).toBe(false)
    // `.cursor` exists (so the CLI has somewhere to write) but is a real empty
    // directory, not a link back to the owner's.
    const workerCursor = join(prepared.home, '.cursor')
    expect(existsSync(workerCursor)).toBe(true)
    expect(lstatSync(workerCursor).isSymbolicLink()).toBe(false)
  })

  it('★a transcript the worker writes is visible at the path the DAEMON globs', () => {
    // The daemon reads `~/.cursor/projects/*/agent-transcripts/*` with a
    // literal `~`, which native-history-executor's expandPath() resolves
    // through os.homedir() unconditionally — it never sees the worker's HOME.
    // So this asserts the end-to-end property, not "a symlink was created":
    // write through the WORKER path, read back from the REAL path.
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const workspace = tmp('adhdev-ws-cursor-transcript-')
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace, sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-transcript-'),
    })

    const slug = cursorSlug(workspace)
    const workerTranscripts = join(prepared.home, '.cursor', 'projects', slug, 'agent-transcripts')
    const daemonTranscripts = join(realHome, '.cursor', 'projects', slug, 'agent-transcripts')

    mkdirSync(join(workerTranscripts, 'sess-uuid'), { recursive: true })
    writeFileSync(join(workerTranscripts, 'sess-uuid', 'transcript.jsonl'), '{"role":"assistant"}\n')

    // The assertion that matters: the daemon-side path has the content.
    expect(existsSync(daemonTranscripts)).toBe(true)
    expect(readFileSync(join(daemonTranscripts, 'sess-uuid', 'transcript.jsonl'), 'utf-8'))
      .toBe('{"role":"assistant"}\n')
  })

  it('★derives the project slug cursor actually uses (COLLAPSES dash runs)', () => {
    // Measured live 2026-09-17 against cursor-agent under an isolated HOME.
    // A wrong slug does not error — it links a directory nothing ever writes,
    // so every cursor worker silently reports zero assistant messages.
    expect(deriveCursorWorkspaceSlug('/private/tmp/foo/bar')).toBe('private-tmp-foo-bar')

    // ★The case that a naive "separator → dash" rule gets WRONG, and the reason
    // this test exists. Real ADHDev worktree paths contain `/-Users-vilmire--`;
    // cursor collapses the run, the naive rule doubles it. The first live probe
    // used a dash-free path and could not distinguish the two.
    expect(deriveCursorWorkspaceSlug('/tmp/x/-lead--double/y')).toBe('tmp-x-lead-double-y')
    expect(deriveCursorWorkspaceSlug('/private/tmp/claude-501/-Users-vilmire--adhdev/ws'))
      .toBe('private-tmp-claude-501-Users-vilmire-adhdev-ws')
    // Never a leading or trailing dash.
    expect(deriveCursorWorkspaceSlug('/-a-/')).toBe('a')

    // No length cap: a 186-char slug was produced intact by the live CLI.
    const deep = '/' + Array.from({ length: 12 }, (_, i) => `segment-number-${i}`).join('/')
    expect(deriveCursorWorkspaceSlug(deep).length).toBeGreaterThan(158)
    expect(deriveCursorWorkspaceSlug(deep)).not.toMatch(/--/)
  })

  it('★links ONLY agent-transcripts — worker approvals must not land in the owner store', () => {
    // mcp-approvals.json and .workspace-trusted sit in the SAME project
    // directory as agent-transcripts. Linking the parent would route the
    // worker's approval writes into the owner's real store, re-opening the
    // leak the private HOME exists to close.
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const workspace = tmp('adhdev-ws-cursor-approvals-')
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace, sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-approvals-'),
    })

    const slug = cursorSlug(workspace)
    const workerProject = join(prepared.home, '.cursor', 'projects', slug)
    const realProject = join(realHome, '.cursor', 'projects', slug)

    // The project directory itself is a real directory in the worker HOME.
    expect(lstatSync(workerProject).isSymbolicLink()).toBe(false)
    // Only the transcripts leaf is linked through.
    expect(lstatSync(join(workerProject, 'agent-transcripts')).isSymbolicLink()).toBe(true)

    // A worker approval write stays worker-side.
    writeFileSync(join(workerProject, 'mcp-approvals.json'), JSON.stringify({ 'adhdev-mesh-worker': true }))
    writeFileSync(join(workerProject, '.workspace-trusted'), '')
    expect(existsSync(join(realProject, 'mcp-approvals.json'))).toBe(false)
    expect(existsSync(join(realProject, '.workspace-trusted'))).toBe(false)
  })

  it('★does NOT import cli-config.json (no token in it, and cursor rewrites it every run)', () => {
    // Measured: a Library/Keychains symlink alone yields `✓ Logged in as …`.
    // cli-config.json holds identity metadata, not credentials; cursor rewrites
    // it on every invocation (a symlink would let a worker mutate the owner's
    // file) and it is 0644, so requireOwnerOnly would throw on it.
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    expect(spec.imports.some((entry) => entry.relativePath.includes('cli-config.json'))).toBe(false)

    const realHome = fakeCursorHome()
    writeFileSync(join(realHome, '.cursor', 'cli-config.json'), JSON.stringify({ authInfo: { email: 'owner@example.com' } }))
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-cursor-cliconfig-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-cliconfig-'),
    })
    expect(existsSync(join(prepared.home, '.cursor', 'cli-config.json'))).toBe(false)
  })

  it('links Library/Keychains so the worker stays logged in', () => {
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-cursor-auth-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-auth-'),
    })
    const linked = join(prepared.home, 'Library', 'Keychains')
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(linked, 'login.keychain-db'), 'utf-8')).toBe('fixture-keychain')
  })

  it('creates the real-side project dir on a first-ever launch in a workspace', () => {
    // A workspace cursor has never opened has no project directory. Skipping
    // the link there would leave the worker writing transcripts into its
    // private HOME, where the daemon never looks — a silent zero-message
    // session rather than a visible failure.
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const workspace = tmp('adhdev-ws-cursor-firstrun-')
    expect(existsSync(join(realHome, '.cursor', 'projects'))).toBe(false)

    const prepared = prepareWorkerPrivateHome(spec, {
      workspace, sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-firstrun-'),
    })
    const slug = cursorSlug(workspace)
    expect(existsSync(join(realHome, '.cursor', 'projects', slug, 'agent-transcripts'))).toBe(true)
    expect(prepared.imported).toContain(join('.cursor', 'projects', slug, 'agent-transcripts'))
  })

  it('gives two cursor workers on one workspace DIFFERENT private homes', () => {
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const workspace = tmp('adhdev-ws-cursor-two-')
    const baseDir = tmp('adhdev-whbase-cursor-two-')
    const a = prepareWorkerPrivateHome(spec, { workspace, sessionKey: 'task_1', realHome, baseDir })
    const b = prepareWorkerPrivateHome(spec, { workspace, sessionKey: 'task_2', realHome, baseDir })
    expect(a.home).not.toBe(b.home)
    // Both still reach the same daemon-read transcript directory.
    const slug = cursorSlug(workspace)
    const rel = join('.cursor', 'projects', slug, 'agent-transcripts')
    expect(realpathSync(join(a.home, rel))).toBe(realpathSync(join(b.home, rel)))
  })

  it('is re-runnable for the same key (relaunch replaces the stale link)', () => {
    const realHome = fakeCursorHome()
    const spec = findWorkerPrivateHomeSpec('cursor-cli')!
    const args = { workspace: tmp('adhdev-ws-cursor-rerun-'), sessionKey: 'task_1', realHome, baseDir: tmp('adhdev-whbase-cursor-rerun-') }
    const first = prepareWorkerPrivateHome(spec, args)
    expect(() => prepareWorkerPrivateHome(spec, args)).not.toThrow()
    expect(prepareWorkerPrivateHome(spec, args).home).toBe(first.home)
  })
})

/**
 * Build a realistic fake home for grok.
 *
 * ★The leak surface is `~/.cursor/mcp.json` and `~/.claude.json`, NOT a grok
 * file. grok's harness-compatibility layer imports cursor's / claude's config
 * alongside its own, which is how the owner's personal servers reached a worker
 * that declared none. Measured 2026-09-18 against grok 1.0.34: an otherwise
 * EMPTY home containing only `~/.cursor/mcp.json` still produced the server,
 * while `grok mcp list` (grok's own native store) was empty.
 */
function fakeGrokHome(): string {
  const home = tmp('adhdev-grok-realhome-')
  const grok = join(home, '.grok')
  mkdirSync(grok, { recursive: true })
  // Auth must be owner-only or the import is refused by design.
  writeFileSync(join(grok, 'auth.json'), '{"token":"fixture"}')
  chmodSync(join(grok, 'auth.json'), 0o600)
  writeFileSync(join(grok, 'config.toml'), '[models]\ndefault = "grok-4.6"\n')
  writeFileSync(join(grok, 'version.json'), '{"version":"1.0.34"}')
  mkdirSync(join(grok, 'sessions'), { recursive: true })
  mkdirSync(join(grok, 'bin'), { recursive: true })
  // The owner's personal servers, reached through the CURSOR compat source.
  mkdirSync(join(home, '.cursor'), { recursive: true })
  writeFileSync(
    join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } }),
  )
  return home
}

describe('grok worker-private HOME', () => {
  it('★the owner\'s ~/.cursor/mcp.json is NOT visible from the worker HOME', () => {
    // The measured root cause. grok labels these servers `.mcp.json [cursor]`,
    // where the bracket is a COMPAT-SOURCE tag, not a path — the file actually
    // read is the owner's HOME-scoped cursor config. Live before/after in one
    // workspace: 4 servers (3 owner-leaked) -> 1.
    const realHome = fakeGrokHome()
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-global-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-global-'),
    })

    expect(existsSync(join(realHome, '.cursor', 'mcp.json'))).toBe(true)
    expect(existsSync(join(prepared.home, '.cursor', 'mcp.json'))).toBe(false)
    // `.cursor` / `.claude` exist but are real empty dirs, not links back.
    for (const dir of ['.cursor', '.claude']) {
      const worker = join(prepared.home, dir)
      expect(existsSync(worker)).toBe(true)
      expect(lstatSync(worker).isSymbolicLink()).toBe(false)
    }
  })

  it('★a transcript the worker writes is visible at the path the DAEMON globs', () => {
    // grok declares `nativeHistory.watchPath: ~/.grok/sessions/**`, and
    // expandPath() resolves a literal `~` through os.homedir() unconditionally —
    // it never sees the worker's HOME. So this asserts the end-to-end property:
    // write through the WORKER path, read back from the REAL path. Without the
    // symlink every grok worker silently reports zero assistant messages.
    const realHome = fakeGrokHome()
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-transcript-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-transcript-'),
    })

    const workerSession = join(prepared.home, '.grok', 'sessions', 'encoded-cwd')
    mkdirSync(workerSession, { recursive: true })
    writeFileSync(join(workerSession, 'chat_history.jsonl'), '{"role":"assistant"}\n')

    expect(readFileSync(join(realHome, '.grok', 'sessions', 'encoded-cwd', 'chat_history.jsonl'), 'utf-8'))
      .toBe('{"role":"assistant"}\n')
  })

  it('★auth is SYMLINKED so an in-place refresh stays shared, config.toml is COPIED', () => {
    // grok refreshes auth.json in place; a copy would strand the worker on a
    // credential that expires mid-task. config.toml is the mirror case — grok
    // REWRITES it, so a symlink would let a worker mutate the owner's file.
    const realHome = fakeGrokHome()
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-auth-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-auth-'),
    })

    const workerAuth = join(prepared.home, '.grok', 'auth.json')
    expect(lstatSync(workerAuth).isSymbolicLink()).toBe(true)
    expect(realpathSync(workerAuth)).toBe(realpathSync(join(realHome, '.grok', 'auth.json')))

    const workerConfig = join(prepared.home, '.grok', 'config.toml')
    expect(lstatSync(workerConfig).isSymbolicLink()).toBe(false)
    writeFileSync(workerConfig, '[models]\ndefault = "worker-edit"\n')
    // The owner's file is untouched by the worker's rewrite.
    expect(readFileSync(join(realHome, '.grok', 'config.toml'), 'utf-8'))
      .toBe('[models]\ndefault = "grok-4.6"\n')
  })

  it('★does NOT import trusted_folders.toml (folder trust gates hooks/plugins)', () => {
    // Deliberate, not an omission. In grok, folder trust gates HOOK and PLUGIN
    // execution rather than the session — every probe ran to completion
    // untrusted with no prompt. Importing it would hand the worker the owner's
    // hook-execution grants; symlinking it would additionally let a worker write
    // new grants into the owner's store.
    const realHome = fakeGrokHome()
    writeFileSync(join(realHome, '.grok', 'trusted_folders.toml'), '[folders."/owner/repo"]\ntrusted = true\n')
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-trust-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-trust-'),
    })

    expect(existsSync(join(prepared.home, '.grok', 'trusted_folders.toml'))).toBe(false)
  })

  it('launches on a host that has never run grok (non-required imports skip)', () => {
    // A fresh machine has no sessions/ or version.json yet. Isolation must not
    // turn a thin home into a spawn failure — only auth.json is `required`.
    const realHome = tmp('adhdev-grok-thin-home-')
    mkdirSync(join(realHome, '.grok'), { recursive: true })
    writeFileSync(join(realHome, '.grok', 'auth.json'), '{"token":"fixture"}')
    chmodSync(join(realHome, '.grok', 'auth.json'), 0o600)

    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-thin-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-thin-'),
    })

    expect(prepared.imported).toContain(join('.grok', 'auth.json'))
    expect(prepared.skipped).toContain(join('.grok', 'sessions'))
    // The isolated surfaces are still created, which is what closes the leak.
    expect(existsSync(join(prepared.home, '.cursor'))).toBe(true)
  })

  it('refuses a world-readable auth.json rather than laundering it', () => {
    const realHome = fakeGrokHome()
    chmodSync(join(realHome, '.grok', 'auth.json'), 0o644)
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    expect(() => prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-grok-perm-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-perm-'),
    })).toThrow(/worker_private_home_insecure_source/)
  })

  it('is re-runnable for the same key (relaunch replaces the stale link)', () => {
    const realHome = fakeGrokHome()
    const spec = findWorkerPrivateHomeSpec('grok-cli')!
    const args = {
      workspace: tmp('adhdev-ws-grok-rerun-'), sessionKey: 'task_1', realHome,
      baseDir: tmp('adhdev-whbase-grok-rerun-'),
    }
    const first = prepareWorkerPrivateHome(spec, args)
    expect(() => prepareWorkerPrivateHome(spec, args)).not.toThrow()
    expect(prepareWorkerPrivateHome(spec, args).home).toBe(first.home)
  })
})

describe('resolveWorkerMcpIsolation (gate ON)', () => {
  it('covers a repo-local provider by writing a worker config', () => {
    const workspace = tmp('adhdev-ws-on-kimi-')
    // ★`realHome` is supplied so this never reads the developer's actual home.
    // kimi gained a private CONFIG ROOT on 2026-09-19; its declared path stays
    // workspace-relative, so the worker config still lands in the workspace —
    // what the root changes is that the owner's GLOBAL mcp.json is no longer
    // merged alongside it.
    const realHome = tmp('adhdev-worker-kimi-cover-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'kimi',
      workspace,
      sessionKey: 'task_1',
      realHome,
      baseDir: tmp('adhdev-whbase-kimi-cover-'),
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.kimi-code/mcp.json' },
    }, ON)

    expect(result).not.toBeNull()
    expect(result!.workerHome).toBeTruthy()
    expect(result!.workerHomeEnvVar).toBe('KIMI_CODE_HOME')
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

  it('★still refuses a home-rooted write when the provider has NO private root', () => {
    // hermes acquired a private root on 2026-09-19, so it no longer exercises
    // this branch — but the branch itself is load-bearing and must keep failing
    // closed: without a private root, resolving `~` would target the
    // COORDINATOR's own config and clobber it. Asserted through a synthetic
    // provider so the guarantee survives every provider gaining a root.
    const result = resolveWorkerMcpIsolation({
      providerType: 'no-such-provider-cli',
      workspace: tmp('adhdev-ws-on-homerooted-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'auto_import', format: 'hermes_config_yaml', path: '~/.hermes/config.yaml' },
    }, ON)

    expect(result!.workerHome).toBeUndefined()
    expect(result!.configPath).toBeUndefined()
    expect(result!.notes.join(' ')).toMatch(/home-rooted/)
  })

  it('delivers worker MCP to codex without requiring a config path', () => {
    const result = resolveWorkerMcpIsolation({
      providerType: 'codex-cli',
      workspace: tmp('adhdev-ws-on-codex-'),
      sessionKey: 'task_1',
      mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh' },
      workerMcpDelivery: {
        mode: 'config_override',
        flag: '-c',
        serverName: 'adhdev-worker',
        commandTemplate: 'mcp_servers.{serverName}.command={command_json}',
        argsTemplate: 'mcp_servers.{serverName}.args={args_json}',
        envVarsTemplate: 'mcp_servers.{serverName}.env_vars={env_vars_json}',
        enabledTemplate: 'mcp_servers.{serverName}.enabled=true',
      },
      server: { command: 'adhdev', args: ['mcp', '--mode', 'ipc', '--worker'] },
      bindContext: { meshId: 'mesh_codex', sessionId: 'sess_codex', spawnedForTaskId: 'task_1' },
    }, ON)
    expect(result!.configPath).toBeUndefined()
    expect(result!.bind).toMatch(/^wsb_/)
    expect(result!.delivery).toMatchObject({
      mode: 'config_override',
      flag: '-c',
      serverName: 'adhdev-worker',
      command: 'adhdev',
      args: ['mcp', '--mode', 'ipc', '--worker'],
      envVars: ['ADHDEV_WORKER_SESSION_BIND'],
      bindEnvVar: 'ADHDEV_WORKER_SESSION_BIND',
    })
    expect(result!.notes.join(' ')).toMatch(/config_override delivery prepared for adhdev-worker/)
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

  /**
   * A `$HOME` that satisfies every private-HOME spec's REQUIRED imports.
   *
   * ★This is what makes the coverage count below a property of the CODE rather
   * than of the machine. Passing no `realHome` lets `resolveWorkerMcpIsolation`
   * fall through to the host's actual home, so the result depended on whether
   * the person running the suite happened to have used grok — which is exactly
   * how this test passed on the owner's Mac and failed on every CI runner
   * (measured 2026-09-18: 4 of 5 on a runner, 5 of 5 locally).
   */
  function homeSatisfyingPrivateHomeSpecs(): string {
    const home = tmp('adhdev-worker-coverhome-')
    // grok-cli declares `.grok/auth.json` as `required` + `requireOwnerOnly`.
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(join(home, '.grok', 'auth.json'), '{"access_token":"x"}', { mode: 0o600 })
    // cursor-cli's only import (`Library/Keychains`) is NOT required, so a host
    // without it still prepares a private HOME — no fixture needed here.
    return home
  }

  it('★covers the five repo-local auto-import providers — counted', () => {
    // Gate-authoring checklist ②: count the scanned surface, do not assume it.
    const repoLocal = [
      { providerType: 'claude-cli', path: '.mcp.json', format: 'claude_mcp_json' },
      { providerType: 'cursor-cli', path: '.cursor/mcp.json', format: 'claude_mcp_json' },
      { providerType: 'grok-cli', path: '.mcp.json', format: 'claude_mcp_json' },
      { providerType: 'kimi', path: '.kimi-code/mcp.json', format: 'claude_mcp_json' },
      { providerType: 'opencode', path: 'opencode.json', format: 'opencode_json' },
    ]
    const realHome = homeSatisfyingPrivateHomeSpecs()
    let written = 0
    for (const provider of repoLocal) {
      const workspace = tmp(`adhdev-ws-cover-${provider.providerType}-`)
      const result = resolveWorkerMcpIsolation({
        providerType: provider.providerType,
        workspace,
        sessionKey: 'task_1',
        realHome,
        baseDir: tmp(`adhdev-whbase-cover-${provider.providerType}-`),
        mcpConfig: { mode: 'auto_import', format: provider.format, path: provider.path },
      }, ON)
      if (result?.configPath && existsSync(result.configPath)) written += 1
    }
    expect(written).toBe(repoLocal.length)
  })

  /**
   * ★The other half of the count: a private-HOME provider whose REQUIRED import
   * is absent must write NO workspace config at all.
   *
   * This is the fail-closed contract at `resolveWorkerMcpIsolation`'s private-HOME
   * catch, and it is deliberate — writing the workspace config while the private
   * HOME failed would leave the worker reading the COORDINATOR's `$HOME`, which is
   * the leak the private HOME exists to close (grok's compat layer imports
   * `~/.cursor/mcp.json`; a worker was measured holding 61 tools where 6 were
   * expected). A config-without-isolation is strictly worse than no config.
   *
   * Pinned here because CI surfaced it by accident rather than by assertion: the
   * runner has no `~/.grok`, so grok took this branch and the count above came
   * back 4. The behaviour was correct; only the count's hidden host-dependency
   * was wrong. Asserting it explicitly means a future change to the catch is
   * caught by a red test instead of by a confusing off-by-one somewhere else.
   */
  it('★fails CLOSED: a private-HOME provider missing a required import writes no config', () => {
    const emptyHome = tmp('adhdev-worker-emptyhome-')
    const workspace = tmp('adhdev-ws-cover-grok-nohome-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'grok-cli',
      workspace,
      sessionKey: 'task_1',
      realHome: emptyHome,
      baseDir: tmp('adhdev-whbase-grok-nohome-'),
      mcpConfig: { mode: 'auto_import', format: 'claude_mcp_json', path: '.mcp.json' },
    }, ON)

    expect(result!.workerHome).toBeUndefined()
    expect(result!.configPath).toBeUndefined()
    expect(existsSync(join(workspace, '.mcp.json'))).toBe(false)
    expect(result!.notes.join(' ')).toMatch(/private HOME unavailable .*\.grok\/auth\.json not found/)
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

/**
 * ★Config-root-variable providers (codex, kimi, opencode, hermes) — 2026-09-19.
 *
 * Every assertion here is a PROPERTY of the prepared root ("the owner's servers
 * are not reachable from it"), never "a spec entry exists". A spec entry that
 * points at the wrong directory satisfies the second and fails the first, and
 * that is exactly the silent failure these providers are exposed to.
 */
/**
 * ★These four config-root providers are called with the REAL home — the one
 * `os.homedir()` returns — and the spec's `configRootPrefix` is what reaches
 * their `~/<prefix>/…` sources. So every case below passes `realHome` UNprefixed.
 *
 * ★That is not a cosmetic detail; it is the rc.16 regression in one line. These
 * tests used to hand `join(realHome, '.codex')` in as `realHome`, pre-applying
 * the prefix by hand. That made them green against a `prepareWorkerPrivateHome`
 * which joined the import source straight off `realHome` — while the live daemon,
 * passing an unprefixed home, looked for `~/auth.json` and found nothing. The
 * imports are deliberately optional, so the miss was a SILENT skip: an empty
 * private root, and a CLI launched with no credentials at all.
 *
 * Measured on disk at the time: of 34 `codex-cli-*` private roots, 33 were
 * completely empty and ZERO held an `auth.json`.
 *
 * ★So the assertions here deliberately check the TARGET inside the root, never
 * `existsSync(source)` and never `prepared.skipped` — a skip is indistinguishable
 * from a legitimately absent optional file, which is precisely why a fully green
 * suite shipped a defect that killed every codex and kimi worker on launch.
 */
describe('codex worker config root', () => {
  function fakeCodexHome(): string {
    const home = tmp('adhdev-worker-codexhome-')
    mkdirSync(join(home, '.codex'), { recursive: true })
    // The owner's real table: the coordinator entry PLUS two personal servers.
    // `node_repl` is the one measured running as a codex worker's child process.
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.node_repl]', 'command = "node"',
        '[mcp_servers.computer-use]', 'command = "cu"',
        '[mcp_servers.adhdev-mesh]', 'command = "adhdev"',
      ].join('\n'),
      { mode: 0o600 },
    )
    writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{"access_token":"x"}}', { mode: 0o600 })
    return home
  }

  it('★the owner\'s config.toml — and every server in it — is unreachable from the worker root', () => {
    // The defect in one assertion. The old `-c mcp_servers.adhdev-mesh.enabled=false`
    // rule removed ONE entry by name; `node_repl` and `computer-use` survived it.
    // An absent config root removes the whole table, including servers added
    // after this code was written.
    const realHome = fakeCodexHome()
    const spec = findWorkerPrivateHomeSpec('codex-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-codex-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-codex-'),
    })

    // Present in the owner's root...
    expect(existsSync(join(realHome, '.codex', 'config.toml'))).toBe(true)
    // ...and absent from the worker's, which is what CODEX_HOME will name.
    expect(existsSync(join(prepared.home, 'config.toml'))).toBe(false)
  })

  it('★keeps the worker logged in — auth.json is linked, and a refresh stays visible', () => {
    // Isolation that breaks login is worse than no isolation: the worker cannot
    // run at all. Measured live — `CODEX_HOME=<root with auth.json linked>
    // codex login status` reported "Logged in using ChatGPT".
    const realHome = fakeCodexHome()
    const spec = findWorkerPrivateHomeSpec('codex-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-codex-auth-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-codex-auth-'),
    })

    const workerAuth = join(prepared.home, 'auth.json')
    expect(lstatSync(workerAuth).isSymbolicLink()).toBe(true)
    // A token the CLI refreshes in place must reach the worker — a COPY would
    // strand a long worker on a credential that expires mid-task.
    writeFileSync(join(realHome, '.codex', 'auth.json'), '{"tokens":{"access_token":"rotated"}}', { mode: 0o600 })
    expect(readFileSync(workerAuth, 'utf-8')).toContain('rotated')
  })

  it('refuses to launder a world-readable credential', () => {
    const realHome = fakeCodexHome()
    chmodSync(join(realHome, '.codex', 'auth.json'), 0o644)
    const spec = findWorkerPrivateHomeSpec('codex-cli')!
    expect(() => prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-codex-perm-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-codex-perm-'),
    })).toThrow(/insecure_source/)
  })
})

describe('kimi worker config root', () => {
  function fakeKimiHome(opts: { globalMcp?: boolean } = {}): string {
    const home = tmp('adhdev-worker-kimihome-')
    // 0700 to match the real store — prepareWorkerPrivateHome asserts
    // owner-only on credential material and must refuse a loosened source.
    mkdirSync(join(home, '.kimi-code', 'credentials'), { recursive: true, mode: 0o700 })
    chmodSync(join(home, '.kimi-code', 'credentials'), 0o700)
    writeFileSync(join(home, '.kimi-code', 'config.toml'), 'default_model = "k3"\n', { mode: 0o600 })
    writeFileSync(join(home, '.kimi-code', 'credentials', 'kimi-code.json'), '{"t":1}', { mode: 0o600 })
    if (opts.globalMcp) {
      writeFileSync(
        join(home, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { 'owner-global': { command: 'leak' } } }),
      )
    }
    return home
  }

  it('★the global mcp.json is unreachable from the worker root', () => {
    // Measured live 2026-09-19 in BOTH directions: with `$KIMI_CODE_HOME/mcp.json`
    // present, kimi spawned the server declared in it (a marker file proved the
    // child ran); with the same root minus that file, it did not — and a real
    // prompt still completed, so auth survived the redirect.
    const realHome = fakeKimiHome({ globalMcp: true })
    const spec = findWorkerPrivateHomeSpec('kimi')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-kimi-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-kimi-'),
    })

    expect(existsSync(join(realHome, '.kimi-code', 'mcp.json'))).toBe(true)
    expect(existsSync(join(prepared.home, 'mcp.json'))).toBe(false)
  })

  it('★still carries auth — config.toml holds no MCP entries, so linking it whole is safe', () => {
    // The measurement that makes this spec cheap: kimi's MCP table lives ONLY in
    // the separate mcp.json, so config.toml can be linked through with the
    // owner's model/provider/oauth settings and zero MCP entries.
    const realHome = fakeKimiHome({ globalMcp: true })
    const spec = findWorkerPrivateHomeSpec('kimi')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-kimi-auth-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-kimi-auth-'),
    })

    expect(lstatSync(join(prepared.home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(prepared.home, 'config.toml'), 'utf-8')).toContain('default_model')
    expect(readFileSync(join(prepared.home, 'config.toml'), 'utf-8')).not.toContain('mcp')
    expect(existsSync(join(prepared.home, 'credentials', 'kimi-code.json'))).toBe(true)
  })
})

describe('opencode worker config root', () => {
  it('★the owner\'s global opencode.json is unreachable, and auth is untouched', () => {
    // ★opencode splits config from state: credentials live under XDG_DATA_HOME,
    // NOT the config root. So redirecting XDG_CONFIG_HOME isolates the MCP table
    // while leaving auth/sessions completely alone — this spec imports nothing.
    //
    // ★OPENCODE_CONFIG was measured and REJECTED as the mechanism: it MERGES.
    // Pointed at a worker file alongside a decoy global, `opencode mcp list`
    // reported BOTH servers. The config ROOT is what governs.
    const realConfig = tmp('adhdev-worker-ocxdg-')
    mkdirSync(join(realConfig, 'opencode'), { recursive: true })
    writeFileSync(
      join(realConfig, 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { 'owner-global': { type: 'local', command: ['leak'] } } }),
    )

    const spec = findWorkerPrivateHomeSpec('opencode')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-oc-'), sessionKey: 'task_1',
      realHome: realConfig, baseDir: tmp('adhdev-whbase-oc-'),
    })

    expect(existsSync(join(realConfig, 'opencode', 'opencode.json'))).toBe(true)
    expect(existsSync(join(prepared.home, 'opencode', 'opencode.json'))).toBe(false)
    // The directory exists (so the CLI has somewhere to read) but is a real
    // empty directory, not a link back to the owner's.
    expect(existsSync(join(prepared.home, 'opencode'))).toBe(true)
    expect(lstatSync(join(prepared.home, 'opencode')).isSymbolicLink()).toBe(false)
    // Nothing imported: auth lives outside the config root entirely.
    expect(prepared.imported).toEqual([])
  })
})

describe('hermes worker config root', () => {
  function fakeHermesHome(): string {
    const home = tmp('adhdev-worker-hermeshome-')
    mkdirSync(join(home, '.hermes'), { recursive: true })
    writeFileSync(
      join(home, '.hermes', 'config.yaml'),
      'mcp_servers:\n  adhdev:\n    command: adhdev\n  adhdev-mesh:\n    command: adhdev\n',
    )
    writeFileSync(join(home, '.hermes', '.env'), 'PROVIDER_KEY=secret\n', { mode: 0o600 })
    return home
  }

  it('★the owner\'s config.yaml is unreachable, and .env still reaches the worker', () => {
    const realHome = fakeHermesHome()
    const spec = findWorkerPrivateHomeSpec('hermes-cli')!
    const prepared = prepareWorkerPrivateHome(spec, {
      workspace: tmp('adhdev-ws-hermes-'), sessionKey: 'task_1',
      realHome, baseDir: tmp('adhdev-whbase-hermes-'),
    })

    expect(existsSync(join(realHome, '.hermes', 'config.yaml'))).toBe(true)
    expect(existsSync(join(prepared.home, 'config.yaml'))).toBe(false)
    // Credentials survive — `get_env_path()` returns `<HERMES_HOME>/.env`.
    expect(readFileSync(join(prepared.home, '.env'), 'utf-8')).toContain('PROVIDER_KEY')
  })

  it('★DELIVERY: the worker config lands where hermes reads it, not in the owner\'s file', () => {
    // hermes was the one provider receiving NO worker server at all: its
    // declared `~/.hermes/config.yaml` is the owner's real file, and the writer
    // rightly refuses to clobber it without a private root. With one, the write
    // lands in the worker's own file — isolation and delivery are the same fix.
    //
    // ★`HERMES_HOME` names the `.hermes` directory ITSELF, so the declared
    // `~/.hermes/config.yaml` must collapse to `<root>/config.yaml`. Measured:
    // `HERMES_HOME=<dir> hermes config path` → `<dir>/config.yaml`. Writing to
    // `<root>/.hermes/config.yaml` instead would be silently inert.
    const realHome = fakeHermesHome()
    const workspace = tmp('adhdev-ws-hermes-deliver-')
    const result = resolveWorkerMcpIsolation({
      providerType: 'hermes-cli',
      workspace,
      sessionKey: 'task_1',
      realHome,
      baseDir: tmp('adhdev-whbase-hermes-deliver-'),
      mcpConfig: { mode: 'auto_import', format: 'hermes_config_yaml', path: '~/.hermes/config.yaml' },
      server: { command: 'adhdev', args: ['mcp', '--mode', 'worker'] },
    }, ON)

    expect(result!.configPath).toBe(join(result!.workerHome!, 'config.yaml'))
    expect(result!.configHasServer).toBe(true)
    // The owner's file is untouched — still exactly its two servers.
    const ownerConfig = readFileSync(join(realHome, '.hermes', 'config.yaml'), 'utf-8')
    expect(ownerConfig).toContain('adhdev-mesh')
    // ...and the worker's carries the worker server instead.
    expect(readFileSync(result!.configPath!, 'utf-8')).toContain('--mode')
  })
})

describe('config-root providers keep the real HOME', () => {
  it('★surfaces the variable name so the launch seam does not redirect HOME', () => {
    // The pairing that makes these four safe. `workerHomeEnvVar` is what tells
    // cli-delegated-launch to export CODEX_HOME/etc. INSTEAD of HOME; without it
    // the seam would repoint the whole worker process tree's home — breaking
    // git/ssh/shell state and stranding opencode's auth, which deliberately
    // lives outside the config root.
    // Laid out as a REAL home: codex's surfaces live under `~/.codex`, and the
    // spec's `configRootPrefix` is what bridges to them. Writing them flat here
    // would re-encode the very mistake that shipped rc.16.
    const realHome = tmp('adhdev-worker-codexroot-')
    mkdirSync(join(realHome, '.codex'), { recursive: true })
    writeFileSync(join(realHome, '.codex', 'auth.json'), '{"t":1}', { mode: 0o600 })
    writeFileSync(join(realHome, '.codex', 'config.toml'), '[mcp_servers.node_repl]\n', { mode: 0o600 })

    const result = resolveWorkerMcpIsolation({
      providerType: 'codex-cli',
      workspace: tmp('adhdev-ws-codexroot-'),
      sessionKey: 'task_1',
      realHome,
      baseDir: tmp('adhdev-whbase-codexroot-'),
      mcpConfig: { mode: 'manual', serverName: 'adhdev-mesh' },
    }, ON)

    expect(result!.workerHome).toBeTruthy()
    expect(result!.workerHomeEnvVar).toBe('CODEX_HOME')
    // The three HOME-rooted providers must leave it unset, so the seam keeps
    // taking the HOME branch for them.
    expect(resolveWorkerMcpIsolation({
      providerType: 'antigravity-cli',
      workspace: tmp('adhdev-ws-agyroot-'),
      sessionKey: 'task_1',
      realHome: fakeGeminiHome(),
      baseDir: tmp('adhdev-whbase-agyroot-'),
      mcpConfig: { mode: 'auto_import', format: 'gemini_mcp_json', path: '~/.gemini/config/mcp_config.json' },
    }, ON)!.workerHomeEnvVar).toBeUndefined()
  })
})

/**
 * ★rc.16 regression: the private root must come out POPULATED, from a real home.
 *
 * ─── What shipped, and why nothing caught it ────────────────────────────────
 *
 * `prepareWorkerPrivateHome` joined the import SOURCE and the import TARGET from
 * the same `relativePath`. For the three prefixed specs the two ends are not the
 * same path: the root stands in for `~/<prefix>`, so `auth.json` sits at the root
 * of the private dir but at `~/.codex/auth.json` in the real home. Joining both
 * ends off `realHome` sent codex looking for `~/auth.json`, kimi for
 * `~/config.toml`, hermes for `~/.env` — none of which exist.
 *
 * Those imports are deliberately optional (fail-OPEN: a required import that
 * throws would drop the worker back onto the owner's config, re-opening the leak
 * this whole mechanism closes). So the misses were silent skips. Every worker got
 * an EMPTY root and a CLI launched with no credentials:
 *
 *   codex-cli → exit 1 after 3s, `unexpected_exit`
 *   kimi      → `Model "kimi-code/k3" is not configured in config.toml`
 *
 * The suite stayed green because the per-provider cases above pre-applied the
 * prefix when constructing `realHome` — they asserted the mechanism against a
 * call shape the daemon never makes.
 *
 * ─── The shape of the guard ─────────────────────────────────────────────────
 *
 * ★Assert the TARGET exists inside the root, reached from an UNPREFIXED home.
 * Not `existsSync(source)`, not `prepared.skipped` — for an optional entry a skip
 * is indistinguishable from a file the host legitimately lacks, so either proxy
 * re-admits the exact defect while reading as coverage.
 *
 * ★Both workspace shapes are exercised. `realHome` is `os.homedir()` on both
 * paths and `workspace` only seasons the root's name hash, so a base checkout and
 * a cloned worktree cannot diverge here — that is asserted rather than assumed,
 * because it is the question a reviewer will actually ask.
 */
describe('★config-root imports resolve from the real home (rc.16 regression)', () => {
  // A base checkout and a cloned worktree — the two live launch shapes.
  const BASE_WS = '/Users/dev/Work/adhdev'
  const TREE_WS = '/Users/dev/.adhdev-preview/worktrees/adhdev-cloud-mesh/fix-branch'

  interface Case {
    providerType: string
    prefix: string
    /** Root-relative targets that MUST materialize inside the private root. */
    expect: string[]
    seed: (realHome: string) => void
  }

  const CASES: Case[] = [
    {
      providerType: 'codex-cli',
      prefix: '.codex',
      expect: ['auth.json'],
      seed: (h) => {
        mkdirSync(join(h, '.codex'), { recursive: true })
        writeFileSync(join(h, '.codex', 'auth.json'), '{"tokens":{"access_token":"x"}}', { mode: 0o600 })
      },
    },
    {
      providerType: 'kimi',
      prefix: '.kimi-code',
      expect: ['config.toml', 'credentials'],
      seed: (h) => {
        mkdirSync(join(h, '.kimi-code', 'credentials'), { recursive: true, mode: 0o700 })
        chmodSync(join(h, '.kimi-code', 'credentials'), 0o700)
        writeFileSync(join(h, '.kimi-code', 'config.toml'), 'default_model = "k3"\n', { mode: 0o600 })
      },
    },
    {
      providerType: 'hermes-cli',
      prefix: '.hermes',
      expect: ['.env'],
      seed: (h) => {
        mkdirSync(join(h, '.hermes'), { recursive: true })
        writeFileSync(join(h, '.hermes', '.env'), 'PROVIDER_KEY=secret\n', { mode: 0o600 })
      },
    },
  ]

  for (const c of CASES) {
    for (const [wsLabel, workspace] of [['base checkout', BASE_WS], ['cloned worktree', TREE_WS]] as const) {
      it(`${c.providerType}: private root is populated from ~/${c.prefix} (${wsLabel})`, () => {
        const realHome = tmp(`adhdev-rc16-${c.providerType}-`)
        c.seed(realHome)

        const spec = findWorkerPrivateHomeSpec(c.providerType)!
        // ★The prefix is the spec's job, not the caller's.
        expect(spec.configRootPrefix).toBe(c.prefix)

        const prepared = prepareWorkerPrivateHome(spec, {
          workspace,
          sessionKey: 'task_1',
          realHome, // ★unprefixed — exactly what the daemon passes
          baseDir: tmp(`adhdev-rc16-base-${c.providerType}-`),
        })

        // ★The assertion the old code failed: the root is not empty.
        for (const target of c.expect) {
          expect(
            existsSync(join(prepared.home, target)),
            `${c.providerType}: expected ${target} inside the private root (${wsLabel})`,
          ).toBe(true)
          expect(prepared.imported).toContain(target)
        }

        // ...and the credential really resolves to the owner's file, so a
        // rotation reaches a long-running worker.
        if (c.providerType === 'codex-cli') {
          writeFileSync(join(realHome, '.codex', 'auth.json'), '{"tokens":{"access_token":"rotated"}}', { mode: 0o600 })
          expect(readFileSync(join(prepared.home, 'auth.json'), 'utf-8')).toContain('rotated')
        }

        // The isolated surface is still absent — the fix must not re-admit it.
        expect(existsSync(join(prepared.home, c.prefix))).toBe(false)
      })
    }

    it(`${c.providerType}: base and worktree get distinct roots, both populated`, () => {
      const realHome = tmp(`adhdev-rc16-split-${c.providerType}-`)
      c.seed(realHome)
      const spec = findWorkerPrivateHomeSpec(c.providerType)!
      const baseDir = tmp(`adhdev-rc16-splitbase-${c.providerType}-`)

      const base = prepareWorkerPrivateHome(spec, { workspace: BASE_WS, sessionKey: 'task_1', realHome, baseDir })
      const tree = prepareWorkerPrivateHome(spec, { workspace: TREE_WS, sessionKey: 'task_1', realHome, baseDir })

      // ★Isolation stays per-workspace — the two must not share a root.
      expect(base.home).not.toBe(tree.home)
      // ★...and neither may be the empty root that shipped.
      for (const target of c.expect) {
        expect(existsSync(join(base.home, target))).toBe(true)
        expect(existsSync(join(tree.home, target))).toBe(true)
      }
    })
  }

  it('★opencode is deliberately exempt: XDG_CONFIG_HOME is already the declared root', () => {
    // Not an oversight. opencode declares no imports at all — its credentials
    // live under XDG_DATA_HOME, outside the config root — so there is no source
    // path to bridge and no prefix to declare.
    const spec = findWorkerPrivateHomeSpec('opencode')!
    expect(spec.homeEnvVar).toBe('XDG_CONFIG_HOME')
    expect(spec.configRootPrefix).toBeUndefined()
    expect(spec.imports).toEqual([])
  })

  it('★the three HOME-rooted specs declare no prefix — real and private paths coincide', () => {
    // antigravity/cursor/grok redirect HOME itself, so an import source and its
    // target are the same relative path. A prefix here would BREAK them, which
    // is why the fix is scoped to specs that declare one.
    for (const providerType of ['antigravity-cli', 'cursor-cli', 'grok-cli']) {
      const spec = findWorkerPrivateHomeSpec(providerType)!
      expect(spec.homeEnvVar).toBeUndefined()
      expect(spec.configRootPrefix).toBeUndefined()
    }
  })
})

// ─── MCP-usage-audit item 3: worker-MCP delivery visibility ─────────────────
describe('deriveWorkerMcpDeliveryStatus', () => {
  function isolation(partial: Partial<WorkerMcpIsolation>): WorkerMcpIsolation {
    return { notes: [], ...partial }
  }

  it('reads not_applicable when the launch never asked for a worker identity (no bindContext)', () => {
    // This is the ordinary non-mesh launch (user-initiated CLI, or a delegated
    // launch with no mesh identity yet) — not a failure, so it must not read
    // like one.
    expect(deriveWorkerMcpDeliveryStatus(null, false)).toEqual({ delivered: false, reason: 'not_applicable' })
    expect(deriveWorkerMcpDeliveryStatus(isolation({ bind: 'wtb_x', configHasServer: true }), false))
      .toEqual({ delivered: false, reason: 'not_applicable' })
  })

  it('reads not_applicable when bindContext was supplied but the gate is off (isolation is null)', () => {
    expect(deriveWorkerMcpDeliveryStatus(null, true)).toEqual({ delivered: false, reason: 'not_applicable' })
  })

  it('reads delivered when a bind and a server surface (config-written) both landed', () => {
    expect(deriveWorkerMcpDeliveryStatus(isolation({ bind: 'wtb_x', configHasServer: true }), true))
      .toEqual({ delivered: true })
  })

  it('reads delivered for the config_override delivery path (bind + delivery descriptor, no configHasServer)', () => {
    expect(deriveWorkerMcpDeliveryStatus(
      isolation({ bind: 'wtb_x', delivery: { mode: 'config_override', flag: '--f', serverName: 's', commandTemplate: 'c', argsTemplate: 'a', envVarsTemplate: 'e', enabledTemplate: 't', command: 'c', args: [], envVars: [], bindEnvVar: 'ADHDEV_WORKER_SESSION_BIND' } }),
      true,
    )).toEqual({ delivered: true })
  })

  it('reads delivered:false with no reason match as unknown, never as a silent pass', () => {
    expect(deriveWorkerMcpDeliveryStatus(isolation({}), true)).toEqual({ delivered: false, reason: 'unknown' })
  })

  const FAILURE_CASES: Array<{ note: string; reason: string }> = [
    { note: 'private HOME unavailable (boom) — falling back to declared isolation only', reason: 'private_home_failed' },
    { note: 'worker MCP config_override delivery unavailable for x — missing server or bind context', reason: 'config_override_missing_context' },
    { note: 'worker MCP config_override delivery failed (boom)', reason: 'config_override_failed' },
    { note: 'no mcpConfig.path declared for x — no worker config written', reason: 'no_mcp_config_declared' },
    { note: 'mcpConfig.format foo is not auto-import writable — relying on declared arg isolation', reason: 'unsupported_config_format' },
    { note: '~/.foo is home-rooted but x has no private HOME — refusing to overwrite the coordinator config', reason: 'home_rooted_no_private_home' },
    { note: 'worker MCP config write failed (boom)', reason: 'config_write_failed' },
  ]

  for (const { note, reason } of FAILURE_CASES) {
    it(`maps the daemon note "${note.slice(0, 40)}…" to reason '${reason}'`, () => {
      expect(deriveWorkerMcpDeliveryStatus(isolation({ notes: [note] }), true)).toEqual({ delivered: false, reason })
    })
  }

  it('never claims delivered when configHasServer is true but no bind was minted', () => {
    // A server entry with no live bind is not a reportable worker — the bind
    // is what the worker exchanges for its task identity.
    expect(deriveWorkerMcpDeliveryStatus(isolation({ configHasServer: true, notes: ['worker MCP config write failed (x)'] }), true))
      .toEqual({ delivered: false, reason: 'config_write_failed' })
  })
})
