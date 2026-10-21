import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';
import { ProviderApprovalLifecycle } from '../../../src/providers/spec/provider-approval-lifecycle.js';
import { isCoordinatorSpawnedHiddenWorker } from '../../../src/status/builders.js';
import { stampLocalClaimedSession } from '../../../src/mesh/mesh-queue-assignment.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';
import { vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');

function loadProviderSpec(providerId: 'codex-cli' | 'claude-cli'): CliSpecV4 {
    const candidates = [
        path.join(repoRoot, `adhdev-providers/cli/${providerId}/specs/4.0.json`),
        path.join(process.env.HOME ?? '', `.adhdev/providers/.upstream/cli/${providerId}/specs/4.0.json`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error(`${providerId} 4.0.json spec not found in: ${candidates.join(', ')}`);
    const raw = JSON.parse(fs.readFileSync(found, 'utf8'));
    const errs = validateFsmSpec(raw);
    if (errs.length) throw new Error(errs.join('; '));
    return raw as CliSpecV4;
}

function clk(now: number, entered: number): FsmClock {
    return { now, stateEnteredAt: entered, regionLastChangedAt: new Map() };
}

describe('nested approval-text false positive regressions (codex-cli & claude-cli)', () => {
    const codexSpec = loadProviderSpec('codex-cli');
    const claudeSpec = loadProviderSpec('claude-cli');
    const codexApprovalState = codexSpec.states.find(s => s.id === 'approval')!;
    const claudeApprovalState = claudeSpec.states.find(s => s.id === 'approval')!;

    describe('codex-cli', () => {
        it('does NOT enter approval or derive a modal when read_chat output in body/scrollback quotes approval lines while bottom shows Working ( or › ', () => {
            const scrollbackAndBody = [
                '• Ran adhdev-mesh.read_chat({"session_id":"worker-1"})',
                '  {',
                '    "messages": [',
                '      "Would you like to run the following command?",',
                '      "  1. Yes, proceed (y)",',
                '      "  2. No, and tell Codex what to do differently (esc)",',
                '      "  enter to submit | esc to cancel"',
                '    ]',
                '  }',
                '',
                '  Would you like to run the following command?',
                '  $ git status',
                '  1. Yes, proceed (y)',
                '  2. No, and tell Codex what to do differently (esc)',
                '  enter to submit | esc to cancel',
                '',
                '• Explaining what happened in the nested worker session:',
                '  1. Checked the git status.',
                '  2. Verified the branch.',
            ];

            // Case 1: bottom of viewport shows active Working ( spinner
            const busyViewportLines = [
                ...scrollbackAndBody.slice(-14),
                '',
                '  Working (⣿ 12s · esc to interrupt)',
                '',
                '› ',
                '  tab to queue message  ·  ⏎ send',
            ];
            const busyViewport = busyViewportLines.join('\n');
            const busyFullScreen = [...scrollbackAndBody, ...busyViewportLines].join('\n');
            const busyRow = busyViewportLines.length - 2;

            const evBusy = evaluateFsm(
                codexSpec,
                'busy',
                busyFullScreen,
                { row: busyRow, col: 2 },
                undefined,
                clk(10_000, 0),
                busyViewport,
                { row: busyRow, col: 2 },
            );
            expect(evBusy.fired?.to).not.toBe('approval');

            const busySections = resolveSections(codexSpec.sections ?? {}, busyViewportLines);
            const busyModal = deriveModal(codexApprovalState, busySections, busyViewport, () => {});
            expect(busyModal).toBeNull();

            // Case 2: bottom of viewport shows idle composer › (cursor far below stale scrollback footer)
            const idleViewportLines = [
                ...scrollbackAndBody.slice(-14),
                '',
                '• Summary complete.',
                '',
                '  1. First takeaway',
                '  2. Second takeaway',
                '',
                '› ',
                '  tab to queue message  ·  ⏎ send',
            ];
            const idleViewport = idleViewportLines.join('\n');
            const idleFullScreen = [...scrollbackAndBody, ...idleViewportLines].join('\n');
            const idleRow = idleViewportLines.length - 2;

            const evIdle = evaluateFsm(
                codexSpec,
                'idle',
                idleFullScreen,
                { row: idleRow, col: 2 },
                undefined,
                clk(10_000, 0),
                idleViewport,
                { row: idleRow, col: 2 },
            );
            expect(evIdle.fired?.to).not.toBe('approval');

            const idleSections = resolveSections(codexSpec.sections ?? {}, idleViewportLines);
            const idleModal = deriveModal(codexApprovalState, idleSections, idleViewport, () => {});
            expect(idleModal).toBeNull();
        });

        it('ENTERS approval and extracts buttons when a real active approval modal is at the bottom of the viewport', () => {
            const scrollback = [
                '• Previous read_chat output in scrollback:',
                '  Would you like to run the following command?',
                '  1. Yes, proceed',
                '  enter to submit | esc to cancel',
                '',
            ];
            const viewportLines = [
                '• Preparing to run verification suite:',
                '',
                '  Would you like to run the following command?',
                '',
                '  $ npx vitest run test/status/approval-escalation.test.ts',
                '',
                '  › 1. Yes, proceed (y)',
                '    2. Yes, and don\'t ask again for vitest commands (p)',
                '    3. No, and tell Codex what to do differently (esc)',
                '',
                '  enter to submit | esc to cancel',
            ];
            const viewport = viewportLines.join('\n');
            const fullScreen = [...scrollback, ...viewportLines].join('\n');
            const cursorRow = viewportLines.length - 1; // cursor on/near footer line

            const ev = evaluateFsm(
                codexSpec,
                'busy',
                fullScreen,
                { row: scrollback.length + cursorRow, col: 2 },
                undefined,
                clk(10_000, 0),
                viewport,
                { row: cursorRow, col: 2 },
            );
            expect(ev.fired?.to).toBe('approval');

            const sections = resolveSections(codexSpec.sections ?? {}, viewportLines);
            const modal = deriveModal(codexApprovalState, sections, viewport, () => {});
            expect(modal).not.toBeNull();
            expect(modal?.buttons.map(b => b.index)).toEqual([1, 2, 3]);
            expect(modal?.buttons[0].current).toBe(true);
            expect(modal?.buttons[0].label).toContain('Yes, proceed');
        });
    });

    describe('claude-cli', () => {
        it('does NOT enter approval or derive a modal when read_chat output quotes Do you want to proceed? + 1. Yes while bottom shows spinner or composer', () => {
            const scrollbackAndBody = [
                '● adhdev-mesh - read_chat (MCP)(session_id: "worker-claude")',
                '  ⎿  {',
                '       "content": "Do you want to proceed?\\n  1. Yes\\n  2. No\\nEsc to cancel"',
                '     }',
                '',
                '  Do you want to proceed?',
                '  1. Yes',
                '  2. No',
                '  Esc to cancel',
                '',
                '● Here is the numbered plan:',
                '  1. Inspect the spec',
                '  2. Run the test suite',
            ];

            const viewportLines = [
                ...scrollbackAndBody,
                '',
                '✻ Thinking… (esc to interrupt)',
                '────────────────────────────────────────',
                '❯ ',
                '────────────────────────────────────────',
                '  ⏵⏵ accept edits on (shift+tab to cycle)',
            ];
            const viewport = viewportLines.join('\n');
            const cursorRow = viewportLines.length - 3;

            const ev = evaluateFsm(
                claudeSpec,
                'busy',
                viewport,
                { row: cursorRow, col: 2 },
                undefined,
                clk(10_000, 0),
                viewport,
                { row: cursorRow, col: 2 },
            );
            expect(ev.fired?.to).not.toBe('approval');

            const sections = resolveSections(claudeSpec.sections ?? {}, viewportLines, { row: cursorRow, col: 2 });
            const modal = deriveModal(claudeApprovalState, sections, viewport, () => {});
            expect(modal).toBeNull();
        });

        it('ENTERS approval and extracts buttons when a real active approval modal is at the bottom of the claude-cli viewport', () => {
            const viewportLines = [
                '● Bash(git status)',
                '',
                '────────────────────────────────────────',
                ' Bash command',
                '',
                '   git status',
                '   Check working tree status',
                '',
                ' Do you want to proceed?',
                ' ❯ 1. Yes',
                '   2. Yes, and don\'t ask again for git status commands',
                '   3. No',
                '',
                ' Esc to cancel · Tab to amend',
            ];
            const viewport = viewportLines.join('\n');
            const cursorRow = viewportLines.length - 1;

            const ev = evaluateFsm(
                claudeSpec,
                'busy',
                viewport,
                { row: cursorRow, col: 2 },
                undefined,
                clk(10_000, 0),
                viewport,
                { row: cursorRow, col: 2 },
            );
            expect(ev.fired?.to).toBe('approval');

            const sections = resolveSections(claudeSpec.sections ?? {}, viewportLines, { row: cursorRow, col: 2 });
            const modal = deriveModal(claudeApprovalState, sections, viewport, () => {});
            expect(modal).not.toBeNull();
            expect(modal?.buttons.map(b => b.index)).toEqual([1, 2, 3]);
            expect(modal?.buttons[0].current).toBe(true);
            expect(modal?.buttons[0].label).toBe('Yes');
        });
    });

    describe('status projection and modalKey stability', () => {
        it('projects generating instead of waiting_approval when state.status === approval has no actionable modal buttons', () => {
            const projected = projectAdapterStatus({
                providerSessionId: undefined,
                providerFailure: null,
                exited: false,
                spawned: true,
                activeInteractivePrompt: null,
                state: { id: 'approval', label: 'Approval', title: null, status: 'approval' },
                modal: null,
                readySeen: () => true,
                lastOutputAt: undefined,
                lastScreenChangeAt: undefined,
            });
            expect(projected.status).toBe('generating');
            expect(projected.activeModal).toBeNull();
        });

        it('does not churn modalKey when streaming tail lines change after the first line of modal.title', () => {
            const lifecycle = new ProviderApprovalLifecycle();
            const state = { id: 'approval', label: 'Approval', title: 'Allow command?', status: 'approval' as const };
            const buttons = [{ index: 1, label: 'Yes', key: '1\r', current: true }, { index: 2, label: 'No', key: '2\r' }];

            lifecycle.observe(
                state,
                { title: 'Would you like to run the following command?\n$ git status', buttons, kind: 'approval' },
                1000,
            );
            const firstKey = lifecycle.read()?.modalKey;
            expect(firstKey).toBeTruthy();

            lifecycle.observe(
                state,
                { title: 'Would you like to run the following command?\n$ git status\nstreaming output line 2', buttons, kind: 'approval' },
                1500,
            );
            const secondKey = lifecycle.read()?.modalKey;
            expect(secondKey).toBe(firstKey);
        });
    });

    describe('adopted worker session visibility', () => {
        it('stamps spawnedSessionVisibility: hidden when adopting a local session as a mesh worker', () => {
            let currentSettings: Record<string, unknown> = {};
            const updateSettings = vi.fn((patch: Record<string, unknown>) => {
                currentSettings = { ...currentSettings, ...patch };
            });

            stampLocalClaimedSession(
                {
                    instanceManager: {
                        getInstance: () => ({
                            updateSettings,
                            getState: () => ({ settings: currentSettings }),
                        }),
                    },
                    providerLoader: {
                        getMeta: () => null,
                    },
                } as any,
                {
                    meshId: 'mesh-1',
                    nodeId: 'node-1',
                    sessionId: 'adopted-session-1',
                    providerType: 'codex-cli',
                    task: { id: 'task-1', sourceCoordinatorSessionId: 'coord-1' } as any,
                    mesh: { id: 'mesh-1' },
                    node: { id: 'node-1', workspace: '/tmp/ws', cliType: 'codex-cli' },
                },
            );

            expect(updateSettings).toHaveBeenCalled();
            expect(currentSettings.spawnedSessionVisibility).toBe('hidden');
            expect(isCoordinatorSpawnedHiddenWorker(currentSettings)).toBe(true);
        });
    });
});
