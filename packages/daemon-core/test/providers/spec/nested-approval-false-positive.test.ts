import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFsmSpec } from '../../../src/providers/spec/fsm-loader.js';
import { evaluateFsm, type FsmClock } from '../../../src/providers/spec/fsm-evaluator.js';
import { resolveSections } from '../../../src/providers/spec/evaluator.js';
import { deriveModal } from '../../../src/providers/spec/fsm-driver-modal.js';
import { FsmDriver } from '../../../src/providers/spec/fsm-driver.js';
import { SpecCliAdapter } from '../../../src/providers/spec/cli-adapter.js';
import { projectAdapterStatus } from '../../../src/providers/spec/adapter-status-projection.js';
import { ProviderApprovalLifecycle } from '../../../src/providers/spec/provider-approval-lifecycle.js';
import { isCoordinatorSpawnedHiddenWorker } from '../../../src/status/builders.js';
import { stampLocalClaimedSession } from '../../../src/mesh/mesh-queue-assignment.js';
import type { CliSpecV4 } from '../../../src/providers/spec/fsm-types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../..');

function resolveProviderSpecPath(providerId: 'codex-cli' | 'claude-cli'): string {
    const candidates = [
        path.join(repoRoot, `adhdev-providers/cli/${providerId}/specs/4.0.json`),
        path.join(process.env.HOME ?? '', `.adhdev/providers/.upstream/cli/${providerId}/specs/4.0.json`),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) throw new Error(`${providerId} 4.0.json spec not found in: ${candidates.join(', ')}`);
    return found;
}

function loadProviderSpec(providerId: 'codex-cli' | 'claude-cli'): CliSpecV4 {
    const found = resolveProviderSpecPath(providerId);
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
        it('does NOT enter approval or derive a modal when read_chat output in scrollback quotes approval lines while viewport shows Working ( or › ', () => {
            // TODO(mission 3e9bae23): Nested approval text still visible inside the active
            // viewport is a known limitation, deferred to the ghostty native viewport API.
            const scrollbackAndBody = [
                '• Ran adhdev-mesh.read_chat({"session_id":"worker-1"})',
                '  {',
                '    "messages": [',
                '      "Would you like to run the following command?",',
                '      "  › 1. Yes, proceed (y)",',
                '      "    2. No, and tell Codex what to do differently (esc)",',
                '      "  enter to submit | esc to cancel"',
                '    ]',
                '  }',
                '',
                '  Would you like to run the following command?',
                '  $ git status',
                '  › 1. Yes, proceed (y)',
                '    2. No, and tell Codex what to do differently (esc)',
                '  enter to submit | esc to cancel',
                '',
            ];

            // Case 1: bottom of viewport shows active Working ( spinner while quoted modal is in scrollback
            const busyViewportLines = [
                '• Explaining what happened in the nested worker session:',
                '  Checked the git status and verified the branch.',
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
                { row: scrollbackAndBody.length + busyRow, col: 2 },
                undefined,
                clk(10_000, 0),
                undefined,
                scrollbackAndBody.length,
            );
            expect(evBusy.fired?.to).not.toBe('approval');

            const busySections = resolveSections(codexSpec.sections ?? {}, busyViewportLines);
            const busyModal = deriveModal(codexApprovalState, busySections, busyViewport, () => {});
            expect(busyModal).toBeNull();

            // Case 2: bottom of viewport shows idle composer › while quoted modal is in scrollback
            const idleViewportLines = [
                '• Explaining what happened in the nested worker session:',
                '  Checked the git status and verified the branch.',
                '',
                '• Summary complete.',
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
                { row: scrollbackAndBody.length + idleRow, col: 2 },
                undefined,
                clk(10_000, 0),
                undefined,
                scrollbackAndBody.length,
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
                undefined,
                scrollback.length,
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
        it('does NOT enter approval or derive a modal when read_chat output in scrollback quotes Do you want to proceed? + 1. Yes while viewport shows spinner or composer', () => {
            // TODO(mission 3e9bae23): Nested approval text still visible inside the active
            // viewport is a known limitation, deferred to the ghostty native viewport API.
            const scrollbackAndBody = [
                '● adhdev-mesh - read_chat (MCP)(session_id: "worker-claude")',
                '  ⎿  {',
                '       "content": "Do you want to proceed?\\n  1. Yes\\n  2. No\\nEsc to cancel"',
                '     }',
                '',
                '  Do you want to proceed?',
                '  ❯ 1. Yes',
                '    2. No',
                '  Esc to cancel',
                '',
            ];

            const viewportLines = [
                '● Inspected the spec and ran the test suite.',
                '',
                '✻ Thinking… (esc to interrupt)',
                '────────────────────────────────────────',
                '❯ ',
                '────────────────────────────────────────',
                '  ⏵⏵ accept edits on (shift+tab to cycle)',
            ];
            const viewport = viewportLines.join('\n');
            const fullScreen = [...scrollbackAndBody, ...viewportLines].join('\n');
            const cursorRow = viewportLines.length - 3;

            const ev = evaluateFsm(
                claudeSpec,
                'busy',
                fullScreen,
                { row: scrollbackAndBody.length + cursorRow, col: 2 },
                undefined,
                clk(10_000, 0),
                undefined,
                scrollbackAndBody.length,
            );
            expect(ev.fired?.to).not.toBe('approval');

            const sections = resolveSections(claudeSpec.sections ?? {}, viewportLines);
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
                undefined,
                0,
            );
            expect(ev.fired?.to).toBe('approval');

            const sections = resolveSections(claudeSpec.sections ?? {}, viewportLines);
            const modal = deriveModal(claudeApprovalState, sections, viewport, () => {});
            expect(modal).not.toBeNull();
            expect(modal?.buttons.map(b => b.index)).toEqual([1, 2, 3]);
            expect(modal?.buttons[0].current).toBe(true);
            expect(modal?.buttons[0].label).toBe('Yes');
        });
    });

    describe('real-modal and GhosttyVT rendered counterexamples', () => {
        function runDriver(spec: CliSpecV4, scrollback: string, viewport: string, cursor = { row: 20, col: 1 }) {
            const fullText = scrollback ? `${scrollback}\n${viewport}` : viewport;
            const viewportLines = viewport.split('\n');
            const viewportStartRow = scrollback ? scrollback.split('\n').length : 0;
            const ev = evaluateFsm(spec, 'busy', fullText, cursor, undefined, clk(5000, 1000), undefined, viewportStartRow);
            const stateId = ev.fired?.to ?? 'busy';
            const stateObj = spec.states.find(s => s.id === stateId) ?? null;
            const sections = resolveSections(spec.sections ?? {}, viewportLines);
            const modal = stateObj ? deriveModal(stateObj, sections, viewportLines.join('\n'), () => {}) : null;
            const state = stateObj
                ? { id: stateObj.id, label: stateObj.label, title: modal?.title ?? null, status: stateObj.status ?? (stateObj.modal ? ('approval' as const) : ('idle' as const)) }
                : null;
            const projected = projectAdapterStatus({
                providerSessionId: 'p1',
                providerFailure: null,
                exited: false,
                spawned: true,
                activeInteractivePrompt: null,
                state,
                modal,
                readySeen: () => true,
                lastOutputAt: undefined,
                lastScreenChangeAt: undefined,
            });
            return { stateId, modal, status: projected.status };
        }

        class MockPty {
            pid = 12345;
            ready = Promise.resolve();
            cb: ((s: string) => void) | undefined;
            exit: ((info: { exitCode: number }) => void) | undefined;
            write() {}
            resize() {}
            kill() {
                this.exit?.({ exitCode: 0 });
            }
            onData(cb: (s: string) => void) {
                this.cb = cb;
            }
            onExit(cb: (info: { exitCode: number }) => void) {
                this.exit = cb;
            }
            feed(s: string) {
                this.cb?.(s);
            }
        }

        async function runGhostty(providerId: 'codex-cli' | 'claude-cli', chunks: string[], cols = 80, rows = 24) {
            vi.useFakeTimers();
            const pty = new MockPty();
            const driver = new FsmDriver({
                specPath: resolveProviderSpecPath(providerId),
                workingDir: os.tmpdir(),
                hotReload: false,
                cols,
                rows,
                transportFactory: { spawn: () => pty as any },
            });
            let latestState: any = null;
            let latestModal: any = null;
            driver.subscribe((ev) => {
                if (ev.kind === 'state_changed') {
                    latestState = ev.state;
                    latestModal = ev.modal;
                }
            });
            try {
                driver.start();
                for (const c of chunks) pty.feed(c);
                await vi.advanceTimersByTimeAsync(500);
                const status = projectAdapterStatus({
                    providerSessionId: 'p1',
                    providerFailure: null,
                    exited: false,
                    spawned: true,
                    activeInteractivePrompt: null,
                    state: latestState,
                    modal: latestModal,
                    readySeen: () => true,
                    lastOutputAt: undefined,
                    lastScreenChangeAt: undefined,
                });
                return { state: latestState?.id, modal: latestModal, status: status.status };
            } finally {
                driver.shutdown();
                vi.useRealTimers();
            }
        }

        it('preserves codex tall approval (34 detail lines between header and buttons)', () => {
            const details = Array.from({ length: 34 }, (_, i) => `  M packages/pkg-${i}/src/file-${i}.ts`).join('\n');
            const viewport = [
                'Would you like to run the following command?',
                '  $ git status --porcelain',
                details,
                '› 1. Yes, proceed (y)',
                "  2. Yes, and don't ask again for git status commands (a)",
                '  3. No, and tell Codex what to do differently (esc)',
                '',
                '  enter to submit | esc to cancel',
            ].join('\n');
            expect(runDriver(codexSpec, '', viewport).status).toBe('waiting_approval');
        });

        it('preserves codex approval whose header scrolled into scrollback', () => {
            const scrollback = [
                'Would you like to run the following command?',
                '',
                'Reason: inspect diff before staging',
                '',
                '$ git diff --stat',
            ].join('\n');
            const viewport = [
                ' packages/daemon-core/src/index.ts | 2 +-',
                ' 24 files changed, 80 insertions(+), 12 deletions(-)',
                '',
                '› 1. Yes, proceed (y)',
                "  2. Yes, and don't ask again for git diff commands (a)",
                '  3. No, and tell Codex what to do differently (esc)',
                '',
                '  enter to submit | esc to cancel',
            ].join('\n');
            expect(runDriver(codexSpec, scrollback, viewport).status).toBe('waiting_approval');
        });

        it('preserves codex approval whose command contains Thinking or Planning', () => {
            for (const word of ['Thinking', 'Planning']) {
                const viewport = [
                    'Would you like to run the following command?',
                    '',
                    `  $ rg ${word} packages/daemon-core/src`,
                    '',
                    '› 1. Yes, proceed (y)',
                    `  2. Yes, and don't ask again for rg ${word} commands (a)`,
                    '  3. No, and tell Codex what to do differently (esc)',
                    '',
                    '  enter to submit | esc to cancel',
                ].join('\n');
                expect(runDriver(codexSpec, '', viewport).status).toBe('waiting_approval');
            }
        });

        it('preserves claude approval with focus moved to option 2 (command and MCP)', () => {
            const cmdViewport = [
                '────────────────────────────────────────',
                ' Bash command',
                '',
                '   npm test',
                '',
                ' Do you want to proceed?',
                '   1. Yes',
                " ❯ 2. Yes, and don't ask again this session",
                '   3. No',
                '',
                ' Esc to cancel · Tab to amend',
            ].join('\n');
            expect(runDriver(claudeSpec, '', cmdViewport).status).toBe('waiting_approval');

            const mcpViewport = [
                '────────────────────────────────────────',
                ' Claude in Chrome wants to navigate on localhost:4173',
                '',
                ' http://localhost:4173/',
                '',
                '   1. Allow',
                ' ❯ 2. Allow all actions on localhost:4173 for this session',
                '   3. Deny (esc)',
            ].join('\n');
            expect(runDriver(claudeSpec, '', mcpViewport).status).toBe('waiting_approval');
        });

        it('preserves claude multi-line bash command before option 1', () => {
            const viewport = [
                '────────────────────────────────────────',
                ' Bash command',
                '',
                '   git status --short \\',
                '     --branch',
                '',
                ' Do you want to proceed?',
                ' ❯ 1. Yes',
                '   2. No',
                '',
                ' Esc to cancel',
            ].join('\n');
            expect(runDriver(claudeSpec, '', viewport).status).toBe('waiting_approval');
        });

        it('preserves GhosttyVT rendered modals (top-of-screen with blank rows, scrolled 60-line output, Claude option 2, and 36-col narrow terminal)', async () => {
            expect((await runGhostty('codex-cli', [
                '\x1b[2J\x1b[H'
                + '\r\n'.repeat(8)
                + 'Would you like to run the following command?\r\n\r\n'
                + '  $ npm test\r\n\r\n'
                + '› 1. Yes, proceed (y)\r\n'
                + "  2. Yes, and don't ask again (a)\r\n"
                + '  3. No, and tell Codex what to do differently (esc)\r\n\r\n'
                + '  enter to submit | esc to cancel',
            ])).status).toBe('waiting_approval');

            const sixtyLines = Array.from({ length: 60 }, (_, i) => `output line ${i + 1}\r\n`).join('');
            expect((await runGhostty('codex-cli', [
                sixtyLines,
                'Would you like to run the following command?\r\n'
                + '  $ rg Thinking src\r\n'
                + '› 1. Yes, proceed (y)\r\n'
                + "  2. Yes, and don't ask again (a)\r\n"
                + '  3. No (esc)\r\n'
                + '  enter to submit | esc to cancel\r\n',
            ])).status).toBe('waiting_approval');

            expect((await runGhostty('claude-cli', [
                '────────────────────────────────────────\r\n'
                + ' Bash command\r\n\r\n'
                + '   npm test\r\n\r\n'
                + ' Do you want to proceed?\r\n'
                + '   1. Yes\r\n'
                + " ❯ 2. Yes, and don't ask again\r\n"
                + '   3. No\r\n\r\n'
                + ' Esc to cancel · Tab to amend',
            ])).status).toBe('waiting_approval');

            expect((await runGhostty('codex-cli', [
                'Would you like to run the following command?\r\n'
                + '  $ git status\r\n'
                + '› 1. Yes, proceed (y)\r\n'
                + "  2. Yes, and don't ask again (a)\r\n"
                + '  3. No (esc)\r\n'
                + '  enter to submit | esc to cancel',
            ], 36, 24)).status).toBe('waiting_approval');
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

        it('transient buttonless repaint does not permanently resolve a live approval', () => {
            const lifecycle = new ProviderApprovalLifecycle();
            const state = { id: 'approval', label: 'Approval', title: 'Run?', status: 'approval' as const };
            const modal = {
                kind: 'approval' as const,
                title: 'Run?',
                buttons: [
                    { index: 1, label: 'Yes', key: '1\r', current: true },
                    { index: 2, label: 'No', key: '2\r' },
                ],
            };
            const adapter = Object.create(SpecCliAdapter.prototype) as any;
            Object.assign(adapter, {
                providerSessionId: 'p1',
                providerFailure: null,
                exited: false,
                spawned: true,
                activeInteractivePrompt: null,
                latestState: state,
                latestModal: modal,
                runtimeSettings: {},
                approvalLifecycle: lifecycle,
                maybeConfirmLiveAuthBillingSuspect() {},
                refreshWirePendingQuestion() {},
                refreshAntigravityTuiPrompt() {},
                driver: { hasSeenReady: () => true, updateMeta() {} },
            });

            lifecycle.observe(state, modal, 1000);
            const initial = adapter.getStatus();
            expect(initial.providerApproval?.lifecycle).toBe('pending');
            const initialModalKey = initial.providerApproval?.modalKey;

            lifecycle.observe(state, null, 1100);
            adapter.latestModal = null;
            adapter.getStatus();

            lifecycle.observe(state, modal, 1200);
            adapter.latestModal = modal;
            const status = adapter.getStatus();
            expect(status.status).toBe('waiting_approval');
            expect(status.providerApproval?.lifecycle).toBe('pending');
            expect(status.providerApproval?.evidence).toBe('live');
            expect(status.providerApproval?.actionable).toBe(true);
            expect(status.providerApproval?.modalKey).toBe(initialModalKey);
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
