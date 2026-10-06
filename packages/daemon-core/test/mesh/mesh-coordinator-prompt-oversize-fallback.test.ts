import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    applyMeshCoordinatorSystemPromptInjection,
    cleanupCoordinatorAgentFile,
    resolveCoordinatorInlinePromptLimit,
    stripCoordinatorWrapperFile,
} from '../../src/commands/mesh-coordinator.js';
import { buildCoordinatorSystemPrompt } from '../../src/mesh/coordinator-prompt.js';
import { describeWin32CommandLineOverflow } from '../../src/cli-adapters/provider-cli-runtime.js';
import { validateCliProviderManifest } from '../../src/providers/sdk/v1/validators/manifest.js';

// WIN32-ARGV-LIMIT: claude-cli / codex-cli / grok-cli deliver the mesh
// coordinator prompt inline on argv (cli_arg / config_override). The prompt
// is ~48k+ chars; win32 CreateProcess caps the whole command line at 32,767
// chars and cmd.exe (npm .cmd shims) at 8,191, so those launches could never
// start on Windows. An inline rule now declares a file-based
// `oversizeFallback` the daemon switches to over the limit, and a rule with no
// fallback fails the launch with a clear error instead of an obscure spawn
// failure. These tests drive the REAL manifests from the sibling
// adhdev-providers checkout so a spec regression shows up here too.

type CliType = 'claude-cli' | 'codex-cli' | 'grok-cli';

function loadRealManifest(type: CliType): Record<string, any> {
    let current = path.resolve(__dirname, '..', '..');
    for (let hops = 0; hops < 8; hops += 1) {
        const candidate = path.join(current, 'adhdev-providers', 'cli', type, 'provider.v1.json');
        if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        current = path.dirname(current);
    }
    throw new Error(`sibling adhdev-providers checkout not found for ${type}`);
}

function realCoordinatorPrompt(): string {
    return buildCoordinatorSystemPrompt({
        mesh: {
            id: 'mesh_1',
            name: 'ADHDev',
            repoIdentity: 'github.com/acme/adhdev',
            nodes: [{ id: 'node_1', workspace: '/repo', daemonId: 'daemon_1', userOverrides: {}, policy: {} }],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
        } as any,
    });
}

const workspaces: string[] = [];
const agentFiles: string[] = [];
function tempWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-oversize-'));
    workspaces.push(dir);
    return dir;
}
afterEach(() => {
    for (const f of agentFiles.splice(0)) cleanupCoordinatorAgentFile(f);
    for (const d of workspaces.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function inject(type: CliType, prompt: string, platform: NodeJS.Platform, workspace = tempWorkspace(), viaCmdShell?: boolean) {
    const manifest = loadRealManifest(type);
    const cliArgs: string[] = [];
    const launchEnv: Record<string, string> = {};
    const effect = applyMeshCoordinatorSystemPromptInjection(
        prompt,
        manifest.meshCoordinator.systemPromptInjection,
        { cliArgs, launchEnv, workspace, cliType: type, platform, viaCmdShell },
    );
    if (effect.agentFilePath) agentFiles.push(effect.agentFilePath);
    return { cliArgs, launchEnv, effect, workspace, manifest };
}

describe('coordinator prompt size vs the win32 argv limit', () => {
    it('the real coordinator prompt is over every win32 inline limit (the premise)', () => {
        const prompt = realCoordinatorPrompt();
        expect(prompt.length).toBeGreaterThan(resolveCoordinatorInlinePromptLimit('win32', false));
        expect(prompt.length).toBeGreaterThan(resolveCoordinatorInlinePromptLimit('win32', true));
    });

    it('resolves conservative limits: unknown shell on win32 counts as cmd.exe', () => {
        expect(resolveCoordinatorInlinePromptLimit('win32')).toBe(8_000);
        expect(resolveCoordinatorInlinePromptLimit('win32', true)).toBe(8_000);
        expect(resolveCoordinatorInlinePromptLimit('win32', false)).toBe(30_000);
        expect(resolveCoordinatorInlinePromptLimit('linux')).toBe(120_000);
        expect(resolveCoordinatorInlinePromptLimit('darwin')).toBe(256_000);
    });

    it.each(['claude-cli', 'codex-cli', 'grok-cli'] as const)('%s manifest (with oversizeFallback) passes the v1 schema', (type) => {
        const result = validateCliProviderManifest(loadRealManifest(type));
        expect(result.issues ?? []).toEqual([]);
        expect(result.ok).toBe(true);
    });
});

describe('claude-cli: --append-system-prompt-file fallback', () => {
    it('win32: the prompt goes to a 0600 temp file, only its path reaches argv', () => {
        const prompt = realCoordinatorPrompt();
        const { cliArgs, effect, workspace } = inject('claude-cli', prompt, 'win32');
        expect(effect.error).toBeUndefined();
        expect(effect.agentFilePath).toBeTruthy();
        expect(cliArgs).toEqual(['--append-system-prompt-file', effect.agentFilePath]);
        expect(cliArgs.join(' ').length).toBeLessThan(8_000);
        expect(fs.readFileSync(effect.agentFilePath!, 'utf-8')).toBe(prompt);
        // Never the workspace — the file is daemon-owned temp.
        expect(effect.agentFilePath!.startsWith(workspace)).toBe(false);
        if (process.platform !== 'win32') {
            expect(fs.statSync(effect.agentFilePath!).mode & 0o777).toBe(0o600);
        }
    });

    it('darwin: the same prompt stays inline (unchanged POSIX behaviour)', () => {
        const prompt = realCoordinatorPrompt();
        const { cliArgs, effect } = inject('claude-cli', prompt, 'darwin');
        expect(effect).toEqual({});
        expect(cliArgs).toEqual(['--append-system-prompt', prompt]);
    });

    it('linux: a prompt over MAX_ARG_STRLEN also switches to the file', () => {
        const prompt = 'x'.repeat(130_000);
        const { cliArgs, effect } = inject('claude-cli', prompt, 'linux');
        expect(cliArgs[0]).toBe('--append-system-prompt-file');
        expect(fs.readFileSync(effect.agentFilePath!, 'utf-8')).toBe(prompt);
    });

    it('win32 direct spawn: a prompt under 30k stays inline', () => {
        const prompt = 'y'.repeat(20_000);
        const { cliArgs, effect } = inject('claude-cli', prompt, 'win32', undefined, false);
        expect(effect).toEqual({});
        expect(cliArgs).toEqual(['--append-system-prompt', prompt]);
    });
});

describe('codex-cli: AGENTS.md fallback with a raised project-doc budget', () => {
    it('win32: writes the wrapped prompt to AGENTS.md and adds project_doc_max_bytes, no developer_instructions', () => {
        const prompt = realCoordinatorPrompt();
        const { cliArgs, effect, workspace } = inject('codex-cli', prompt, 'win32');
        expect(effect.error).toBeUndefined();
        expect(effect.contextFilePath).toBe(path.join(workspace, 'AGENTS.md'));
        expect(cliArgs).toEqual(['-c', 'project_doc_max_bytes=262144']);
        expect(cliArgs.some((a) => a.startsWith('developer_instructions='))).toBe(false);
        const written = fs.readFileSync(effect.contextFilePath!, 'utf-8');
        expect(written).toContain('<!-- adhdev-mesh-coordinator-prompt -->');
        expect(written).toContain(prompt);
        // codex truncates project docs at project_doc_max_bytes (default 32 KiB,
        // verified live) — the raised budget must hold the whole file.
        expect(Buffer.byteLength(written)).toBeLessThan(262_144);
        // Inject-then-remove: stripping leaves no AGENTS.md behind when the
        // daemon created it.
        stripCoordinatorWrapperFile(effect.contextFilePath!, effect.contextFileOwned === true);
        expect(fs.existsSync(effect.contextFilePath!)).toBe(false);
    });

    it('win32: keeps user content in an existing AGENTS.md', () => {
        const workspace = tempWorkspace();
        fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# User rules\nkeep me\n');
        const { effect } = inject('codex-cli', realCoordinatorPrompt(), 'win32', workspace);
        stripCoordinatorWrapperFile(effect.contextFilePath!, false);
        expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')).toContain('keep me');
    });

    it('darwin: stays on -c developer_instructions inline', () => {
        const prompt = realCoordinatorPrompt();
        const { cliArgs, effect, workspace } = inject('codex-cli', prompt, 'darwin');
        expect(effect).toEqual({});
        expect(cliArgs).toEqual(['-c', `developer_instructions=${JSON.stringify(prompt)}`]);
        expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false);
    });
});

describe('grok-cli: owned .grok/rules file fallback', () => {
    it('win32: writes a daemon-owned rules file, nothing prompt-sized on argv', () => {
        const prompt = realCoordinatorPrompt();
        const { cliArgs, effect, workspace } = inject('grok-cli', prompt, 'win32');
        expect(effect.error).toBeUndefined();
        expect(effect.contextFilePath).toBe(path.join(workspace, '.grok', 'rules', 'adhdev-mesh-coordinator.md'));
        expect(effect.contextFileOwned).toBe(true);
        expect(cliArgs).toEqual([]);
        expect(fs.readFileSync(effect.contextFilePath!, 'utf-8')).toContain(prompt);
        stripCoordinatorWrapperFile(effect.contextFilePath!, true);
        expect(fs.existsSync(effect.contextFilePath!)).toBe(false);
    });
});

describe('no usable fallback: fail the launch clearly', () => {
    it('cli_arg without oversizeFallback over the limit returns an error and pushes nothing', () => {
        const cliArgs: string[] = [];
        const effect = applyMeshCoordinatorSystemPromptInjection(
            realCoordinatorPrompt(),
            { mode: 'cli_arg', flag: '--append-system-prompt' },
            { cliArgs, launchEnv: {}, workspace: tempWorkspace(), cliType: 'claude-cli', platform: 'win32' },
        );
        expect(effect.errorCode).toBe('mesh_coordinator_prompt_too_long');
        expect(effect.error).toMatch(/too long to pass on the command line/);
        expect(effect.error).toMatch(/oversizeFallback/);
        expect(cliArgs).toEqual([]);
    });

    it('config_override with a fallback whose file write fails returns an error', () => {
        const cliArgs: string[] = [];
        const workspace = tempWorkspace();
        // A regular file where the fallback needs a directory → mkdir fails.
        fs.writeFileSync(path.join(workspace, 'blocker'), 'x');
        const effect = applyMeshCoordinatorSystemPromptInjection(
            realCoordinatorPrompt(),
            {
                mode: 'config_override',
                flag: '-c',
                template: 'developer_instructions={prompt_json}',
                oversizeFallback: { mode: 'context_file', path: 'blocker/AGENTS.md', extraArgs: ['-c', 'x=1'] },
            },
            { cliArgs, launchEnv: {}, workspace, cliType: 'codex-cli', platform: 'win32' },
        );
        expect(effect.errorCode).toBe('mesh_coordinator_prompt_too_long');
        expect(effect.error).toMatch(/fallback failed/);
        expect(cliArgs).toEqual([]);
    });
});

describe('describeWin32CommandLineOverflow (spawn-time diagnostic)', () => {
    it('flags a prompt-sized argument for both cmd.exe and direct spawns', () => {
        const big = 'z'.repeat(40_000);
        expect(describeWin32CommandLineOverflow('claude.exe', ['--append-system-prompt', big], false)).toMatch(/CreateProcess limit/);
        expect(describeWin32CommandLineOverflow('cmd.exe', ['/c', 'claude.cmd', 'z'.repeat(9_000)], true)).toMatch(/cmd\.exe limit/);
    });

    it('stays quiet for an ordinary command line', () => {
        expect(describeWin32CommandLineOverflow('cmd.exe', ['/c', 'claude.cmd', '--append-system-prompt-file', 'C:\\Temp\\x\\coordinator-agent.md'], true)).toBeNull();
    });
});
