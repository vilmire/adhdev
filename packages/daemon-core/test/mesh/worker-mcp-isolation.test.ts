import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetWorkerTaskTokensForTest,
  deriveCursorWorkspaceSlug,
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
  it('declares a spec for antigravity, cursor and grok only', () => {
    expect(findWorkerPrivateHomeSpec('antigravity-cli')).not.toBeNull()
    // cursor joined in 2026-09-17 (its global ~/.cursor/mcp.json is merged into
    // every launch, so a workspace-scoped config alone isolates nothing).
    expect(findWorkerPrivateHomeSpec('cursor-cli')).not.toBeNull()
    // ★grok joined in 2026-09-18 for a RELATED but distinct reason: grok's
    // harness-compatibility layer imports CURSOR's (and claude's) HOME-scoped
    // config, so the owner's `~/.cursor/mcp.json` reached grok workers even
    // though grok's own store was empty. Same remedy, different read path.
    expect(findWorkerPrivateHomeSpec('grok-cli')).not.toBeNull()
    // hermes is deferred by owner decision §12-3; the rest are repo-local.
    for (const other of ['hermes-cli', 'claude-cli', 'codex-cli', 'kimi', 'opencode']) {
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
