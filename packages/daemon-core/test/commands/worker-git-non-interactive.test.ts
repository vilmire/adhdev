import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCoordinatorDelegatedCliLaunchOptions } from '../../src/commands/cli-delegated-launch'
import { gitChildEnv } from '../../src/git/git-locale'

/**
 * NON-INTERACTIVE GIT ADMISSION: git in a delegated worker session and in the
 * daemon's own git children never prompts — no terminal username/password
 * fallback (GIT_TERMINAL_PROMPT=0) and no Git Credential Manager UI
 * (GCM_INTERACTIVE=never). Credentials themselves are not touched.
 */
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('delegated worker launch env — git never prompts', () => {
  it('stamps GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never on every delegated worker', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-worker-git-prompt-'))
    dirs.push(workspace)
    for (const cliType of ['claude-cli', 'codex-cli', 'kimi', 'cursor-cli']) {
      const { env } = buildCoordinatorDelegatedCliLaunchOptions({ cliType, workspace, env: { KEEP: 'yes' } })
      expect(env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(env.GCM_INTERACTIVE).toBe('never')
      expect(env.KEEP).toBe('yes')
    }
  })

  it('overrides a caller/provider env that would re-enable prompting', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-worker-git-prompt-'))
    dirs.push(workspace)
    const { env } = buildCoordinatorDelegatedCliLaunchOptions({
      cliType: 'claude-cli', workspace, env: { GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always' },
    })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
  })

  it('does not touch credential/transport configuration', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'adhdev-worker-git-prompt-'))
    dirs.push(workspace)
    const { env } = buildCoordinatorDelegatedCliLaunchOptions({ cliType: 'claude-cli', workspace, env: {} })
    for (const key of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL', 'HOME']) {
      expect(env).not.toHaveProperty(key)
    }
  })
})

describe('gitChildEnv — daemon git children never prompt', () => {
  it('pins GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never over an inherited value', () => {
    const env = gitChildEnv({ PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always', GIT_ASKPASS: '/bin/helper' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    // A non-interactive askpass helper is a credential source, not a prompt — kept.
    expect(env.GIT_ASKPASS).toBe('/bin/helper')
  })
})
