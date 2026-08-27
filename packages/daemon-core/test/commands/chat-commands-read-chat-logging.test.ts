import { describe, expect, it, vi, afterEach } from 'vitest';
import { LOG } from '../../src/logging/logger.js';
import { getCommandLogLevel } from '../../src/commands/handler.js';
import { handleReadChat } from '../../src/commands/chat-commands-read.js';

// read_chat is a polling hotpath: every coordinator tick issues one per live
// session, so an always-on info log per call floods the default log stream and
// buries real signal.
//
// This suite used to assert on the SOURCE TEXT of chat-commands-read.ts and
// handler.ts — `expect(source).not.toContain("LOG.info('Command', `[read_chat]
// cli-like parsed")` and a regex over the COMMAND_DEBUG_LEVELS literal. That is
// exactly backwards: it pinned one specific spelling of one specific log line
// while saying nothing about the property that matters. A NEW always-on
// `LOG.info('Command', '[read_chat] ...')` added anywhere else in the file — the
// actual regression — kept the suite green, and reformatting the set literal
// across lines turned it red for no reason.
//
// Both properties are directly observable, so they are asserted by running the
// real code with LOG spied instead.

afterEach(() => {
    vi.restoreAllMocks();
});

function spyOnLog() {
    return {
        info: vi.spyOn(LOG, 'info').mockImplementation(() => {}),
        debug: vi.spyOn(LOG, 'debug').mockImplementation(() => {}),
        warn: vi.spyOn(LOG, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(LOG, 'error').mockImplementation(() => {}),
    };
}

// Minimal CommandHelpers surface for the node-scope guard: it only needs the
// session registry to resolve the target session's actual workspace.
function helpersWithSessionWorkspace(sessionId: string, workspace: string): any {
    return {
        ctx: {
            sessionRegistry: {
                get: (id: string) => (id === sessionId ? { workspace } : undefined),
            },
        },
        getCliAdapter: () => undefined,
    };
}

describe('read_chat command log level', () => {
    it('classifies read_chat as a debug-level command so start/end never hit the info stream', () => {
        expect(getCommandLogLevel('read_chat')).toBe('debug');
    });

    it('still classifies ordinary commands as info, so the hotpath rule is not a blanket downgrade', () => {
        expect(getCommandLogLevel('launch_provider')).toBe('info');
        expect(getCommandLogLevel('send_chat')).toBe('info');
    });

    it('keeps the other known polling hotpaths at debug too', () => {
        for (const cmd of ['pty_input', 'pty_resize', 'cdp_eval']) {
            expect(getCommandLogLevel(cmd), `${cmd} should be debug-level`).toBe('debug');
        }
    });
});

describe('handleReadChat logging behavior', () => {
    // The cross-worktree refusal DOES log at info on purpose: it is a rare,
    // actionable event (a coordinator asked the wrong node), not a per-poll line.
    // Pinning it here documents which info logs are intended, so the hotpath
    // assertion below cannot be satisfied by silencing everything.
    it('logs the rare cross-worktree refusal at info exactly once', async () => {
        const log = spyOnLog();
        const helpers = helpersWithSessionWorkspace('sess-1', '/repo/worktree-a');

        const result = await handleReadChat(helpers, {
            targetSessionId: 'sess-1',
            workspace: '/repo/worktree-b',
        });

        // The guard must actually fire — otherwise this test proves nothing.
        expect(result.success).toBe(false);
        expect(result.code).toBe('read_chat_session_node_scope_mismatch');
        expect(result.error).toContain('worktree-a');
        expect(result.error).toContain('worktree-b');

        const infoMessages = log.info.mock.calls.map(call => String(call[1]));
        expect(infoMessages.filter(m => m.includes('[read_chat]'))).toHaveLength(1);
        expect(infoMessages[0]).toContain('node scope mismatch');
    });

    it('emits no info log on an in-scope read — the polling hotpath stays silent', async () => {
        const log = spyOnLog();
        const helpers = helpersWithSessionWorkspace('sess-1', '/repo/worktree-a');

        // Same workspace on both sides → the guard does not scope, so this is the
        // ordinary per-poll path. It then fails in provider resolution on this bare
        // stub; that is fine — the assertion is about the log stream, not the result.
        await handleReadChat(helpers, {
            targetSessionId: 'sess-1',
            workspace: '/repo/worktree-a',
        }).catch(() => undefined);

        const infoMessages = log.info.mock.calls.map(call => String(call[1]));
        expect(
            infoMessages.filter(m => m.includes('[read_chat]')),
            `the read_chat hotpath emitted info logs: ${JSON.stringify(infoMessages)}`,
        ).toEqual([]);
    });
});
