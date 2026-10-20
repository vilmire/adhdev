/**
 * cursor-cli provider.v1.json — live-captured screen regression tests.
 *
 * Drives the REAL cursor-cli manifest (sibling adhdev-providers checkout)
 * through the daemon's declarative TUI builders against screens captured from
 * cursor-agent v2026.08.11, plus the coordinator injection path.
 *
 * Regressions covered:
 *  1. settledPrompt matched the OLD footer ('Auto · 7.7%'); the current build
 *     shows the MODEL label with the context percent ('Kimi K2.7 Code · 6.8%').
 *     With no settled match after a turn, detectStatus fell to preserve-last
 *     and stuck at 'generating' — which made the send gate hold every message
 *     after the first (STALE QUEUE: parsed_status_generating).
 *  2. The startup screen's composer placeholder ('→ Plan, search, build
 *     anything') and bare model label line leaked into the transcript as
 *     assistant messages via the permissive assistantPrefix.
 *  3. meshCoordinator.systemPromptInjection declared cli_arg '--rules', a flag
 *     cursor-agent does not have — coordinator launch exited code 1 instantly.
 *     Now context_file into a daemon-owned .cursor/rules/*.mdc (verified live:
 *     cursor-agent applies alwaysApply rules at session start).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDetectStatusFromTui } from '../../../src/providers/sdk/v1/builders/cli/detect-status.js';
import { buildParseSessionFromTui } from '../../../src/providers/sdk/v1/builders/cli/parse-session.js';
import { applyMeshCoordinatorSystemPromptInjection, stripCoordinatorWrapperFile } from '../../../src/commands/mesh-coordinator.js';
import { scheduleInjectionCleanup } from '../../../src/commands/coordinator-injection-cleanup.js';

function loadManifest(): Record<string, any> {
    let current = path.resolve(__dirname, '..', '..');
    for (let hops = 0; hops < 8; hops += 1) {
        const candidate = path.join(current, 'adhdev-providers', 'cli', 'cursor-cli', 'provider.v1.json');
        if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        current = path.dirname(current);
    }
    throw new Error('sibling adhdev-providers checkout not found for cursor-cli');
}

const manifest = loadManifest();
const tui = manifest.tui as any;

function statusInput(screenText: string): any {
    return {
        tail: screenText.split('\n').slice(-8).join('\n'),
        screenText,
        rawBuffer: screenText,
        isWaitingForResponse: false,
        screen: { text: screenText },
        tailScreen: { text: screenText.split('\n').slice(-8).join('\n') },
    };
}

const detectStatus = buildDetectStatusFromTui({
    spinner: tui.spinner,
    settledPrompt: tui.settledPrompt,
    modal: tui.modal,
    dispatchOrder: tui.dispatchOrder,
});
const parseSession = buildParseSessionFromTui(tui);

// ── Screens captured from cursor-agent v2026.08.11-aaa8809 (pyte, 120x40) ──

const STARTUP_SCREEN = [
    '',
    '  Cursor Agent',
    '  v2026.08.04-aaa8809',
    '  Tip: Use /run-everything to skip all approvals.',
    '',
    '  → Plan, search, build anything',
    '',
    '  Kimi K2.7 Code',
    '  /private/tmp/cursor-probe-ws',
    '',
].join('\n');

const IDLE_SCREEN = [
    '  ● 2',
    '',
    '  → Add a follow-up',
    '',
    '  Kimi K2.7 Code · 6.8%',
    '  /private/tmp/cursor-probe-ws',
].join('\n');

const GENERATING_SCREEN = [
    '  ● 2',
    '',
    '   ⠋ Working…',
    '',
    '  Kimi K2.7 Code',
    '  /private/tmp/cursor-probe-ws',
].join('\n');

describe('cursor-cli detectStatus (real manifest, live-captured screens)', () => {
    it('idle footer (model label + context percent + path) → idle', () => {
        expect(detectStatus(statusInput(IDLE_SCREEN))).toBe('idle');
    });

    it('generating footer (Working spinner) → generating', () => {
        expect(detectStatus(statusInput(GENERATING_SCREEN))).toBe('generating');
    });

    it('startup screen (no percent yet) does not false-match settled', () => {
        // preserve-last with no prior verdict → null (engine treats as starting)
        expect(detectStatus(statusInput(STARTUP_SCREEN))).toBeNull();
    });

    it('older Auto-labelled idle footer still matches', () => {
        const oldIdle = '  Auto · 7.7%\n  ~/Work/adhdev';
        expect(detectStatus(statusInput(oldIdle))).toBe('idle');
    });
});

describe('cursor-cli parseSession transcript chrome (real manifest)', () => {
    it('startup screen produces NO assistant junk (placeholder / model label / tips excluded)', () => {
        const result = parseSession({ buffer: STARTUP_SCREEN, screenText: STARTUP_SCREEN });
        const contents = result.messages.map((m: any) => m.content);
        expect(contents.join('\n')).not.toContain('Plan, search, build anything');
        expect(contents.join('\n')).not.toContain('Kimi K2.7 Code');
        expect(contents.join('\n')).not.toContain('run-everything');
        expect(contents.join('\n')).not.toContain('Cursor Agent');
    });

    it('assistant body text survives while the footer chrome is excluded', () => {
        const screen = [
            '  The answer is 4.',
            '',
            '  → Add a follow-up',
            '',
            '  Kimi K2.7 Code · 6.8%',
            '  /private/tmp/cursor-probe-ws',
        ].join('\n');
        const result = parseSession({ buffer: screen, screenText: screen });
        const texts = result.messages.map((m: any) => `${m.role}:${m.content}`);
        expect(texts).toContain('assistant:The answer is 4.');
        expect(texts.join('\n')).not.toContain('Add a follow-up');
        expect(texts.join('\n')).not.toContain('cursor-probe-ws');
    });
});

describe('cursor-cli mesh coordinator injection (real manifest)', () => {
    it('writes a daemon-owned .cursor/rules mdc, no cli args, and owned cleanup deletes the file', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-coord-'));
        try {
            const cliArgs: string[] = [];
            const launchEnv: Record<string, string> = {};
            const injection = manifest.meshCoordinator.systemPromptInjection;
            expect(injection.mode).toBe('context_file');
            expect(injection.owned).toBe(true);

            const effect = applyMeshCoordinatorSystemPromptInjection(
                'COORDINATOR PROMPT BODY',
                injection,
                { cliArgs, launchEnv, workspace, cliType: 'cursor-cli' },
            );
            const mdcPath = path.join(workspace, '.cursor', 'rules', 'adhdev-mesh-coordinator.mdc');
            expect(effect.contextFilePath).toBe(mdcPath);
            expect(effect.contextFileOwned).toBe(true);
            // Never argv — the missing --rules flag crashed cursor-agent at launch.
            expect(cliArgs).toEqual([]);

            const written = fs.readFileSync(mdcPath, 'utf-8');
            expect(written).toContain('alwaysApply: true');
            expect(written).toContain('<!-- adhdev-mesh-coordinator-prompt -->');
            expect(written).toContain('COORDINATOR PROMPT BODY');

            // Owned cleanup deletes the whole file (no residue in the workspace).
            // Production cleanup passes the writer's sentinels, including MDC frontmatter.
            expect(effect.contextFileSentinels?.open).toContain('alwaysApply: true');
            stripCoordinatorWrapperFile(mdcPath, effect.contextFileOwned === true, effect.contextFileSentinels);
            expect(fs.existsSync(mdcPath)).toBe(false);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('production failed-launch cleanup deletes the writer-owned Cursor MDC', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-coord-failed-'));
        try {
            const effect = applyMeshCoordinatorSystemPromptInjection('BODY', manifest.meshCoordinator.systemPromptInjection, {
                cliArgs: [], launchEnv: {}, workspace, cliType: 'cursor-cli',
            });
            expect(effect.contextFileOwned).toBe(true);
            await scheduleInjectionCleanup(effect, { launched: false, label: 'Cursor regression' });
            expect(fs.existsSync(effect.contextFilePath!)).toBe(false);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it.each(['\n', '\r\n'])('keeps concurrent user prefix/suffix bytes around an owned Cursor wrapper (%j)', (newline) => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-coord-edited-'));
        try {
            const effect = applyMeshCoordinatorSystemPromptInjection('BODY', manifest.meshCoordinator.systemPromptInjection, {
                cliArgs: [], launchEnv: {}, workspace, cliType: 'cursor-cli',
            });
            const prefix = `# User header${newline}${newline}`;
            const suffix = `${newline}${newline}User suffix without final newline`;
            const target = effect.contextFilePath!;
            const written = fs.readFileSync(target, 'utf-8');
            const open = written.indexOf(effect.contextFileSentinels!.open);
            const close = written.indexOf('<!-- /adhdev-mesh-coordinator-prompt -->') + '<!-- /adhdev-mesh-coordinator-prompt -->'.length;
            fs.writeFileSync(target, prefix + written + suffix);
            stripCoordinatorWrapperFile(target, true, effect.contextFileSentinels);
            expect(fs.readFileSync(target, 'utf-8')).toBe(prefix + written.slice(0, open) + written.slice(close) + suffix);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('does not take foreign Cursor frontmatter ownership from forged owned/separator flags', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-coord-foreign-'));
        try {
            const target = path.join(workspace, 'foreign.mdc');
            const header = '---\r\ndescription: User rule\r\nalwaysApply: true\r\n---\r\n\r\n';
            fs.writeFileSync(target, header + '<!-- adhdev-mesh-coordinator-prompt -->FOREIGN<!-- /adhdev-mesh-coordinator-prompt -->');
            stripCoordinatorWrapperFile(target, true, undefined, undefined, { leading: '', trailing: '', createdFile: true });
            expect(fs.readFileSync(target, 'utf-8')).toBe(header);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('keeps a replacement Cursor file user header despite an owned flag', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-coord-replaced-'));
        try {
            const effect = applyMeshCoordinatorSystemPromptInjection('BODY', manifest.meshCoordinator.systemPromptInjection, {
                cliArgs: [], launchEnv: {}, workspace, cliType: 'cursor-cli',
            });
            const target = effect.contextFilePath!;
            const written = fs.readFileSync(target, 'utf-8');
            fs.renameSync(target, target + '.original');
            const header = '# Replacement user rule\r\n\r\n';
            const suffix = '\r\nUser tail without final newline';
            fs.writeFileSync(target, header + written + suffix);
            expect(fs.statSync(target).ino).not.toBe(fs.statSync(target + '.original').ino);
            stripCoordinatorWrapperFile(target, true, effect.contextFileSentinels);
            expect(fs.existsSync(target)).toBe(true);
            expect(fs.readFileSync(target, 'utf-8')).toBe(header + '\n' + suffix);
            expect(fs.readFileSync(target + '.original', 'utf-8')).toBe(written);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

});
