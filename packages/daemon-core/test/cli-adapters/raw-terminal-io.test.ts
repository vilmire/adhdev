import { describe, expect, it } from 'vitest';
import type { SessionHostRequest, SessionHostResponse } from '@adhdev/session-host-core';
import {
    RawTerminalAttachment,
    namedKeyToAnsi,
    namedKeysToAnsi,
} from '../../src/cli-adapters/raw-terminal-io.js';

describe('named terminal keys', () => {
    it('maps base, function, control, and alt keys to ANSI input', () => {
        expect(namedKeysToAnsi([
            'enter', 'escape', 'tab', 'backspace',
            'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space',
            'f1', 'f4', 'f5', 'f12', 'ctrl+a', 'ctrl+z', 'alt+a', 'alt+z',
        ])).toBe(
            '\r\x1b\t\x7f'
            + '\x1b[A\x1b[B\x1b[D\x1b[C\x1b[H\x1b[F\x1b[5~\x1b[6~ '
            + '\x1bOP\x1bOS\x1b[15~\x1b[24~'
            + '\x01\x1a\x1ba\x1bz',
        );
    });

    it('maps shift combinations using xterm modifier sequences', () => {
        expect(namedKeyToAnsi('shift+a')).toBe('A');
        expect(namedKeyToAnsi('shift+tab')).toBe('\x1b[Z');
        expect(namedKeyToAnsi('shift+up')).toBe('\x1b[1;2A');
        expect(namedKeyToAnsi('shift+pageup')).toBe('\x1b[5;2~');
        expect(namedKeyToAnsi('shift+f1')).toBe('\x1b[1;2P');
        expect(namedKeyToAnsi('shift+f12')).toBe('\x1b[24;2~');
        expect(namedKeyToAnsi('shift+alt+a')).toBe('\x1bA');
        expect(namedKeyToAnsi('shift+ctrl+z')).toBe('\x1a');
    });

    it('rejects unsupported names', () => {
        expect(() => namedKeyToAnsi('ctrl+1')).toThrow(/Unsupported named key/);
        expect(() => namedKeyToAnsi('delete')).toThrow(/Unsupported named key/);
    });
});

describe('raw terminal attachment', () => {
    it('attaches to the existing runtime, writes encoded keys, and releases ownership', async () => {
        const requests: SessionHostRequest[] = [];
        const client = {
            async connect() {},
            async request<T>(request: SessionHostRequest): Promise<SessionHostResponse<T>> {
                requests.push(request);
                if (request.type === 'get_terminal_snapshot') {
                    return {
                        success: true,
                        result: {
                            text: 'picker',
                            state: {
                                cursor: { row: 2, col: 3 },
                                altScreen: true,
                                pasteMode: false,
                                rawMode: true,
                                scrollRegion: { top: 0, bot: 23 },
                                cols: 80,
                                rows: 24,
                            },
                        } as T,
                    };
                }
                return { success: true };
            },
            async close() {},
        };

        const attachment = await RawTerminalAttachment.attach({
            sessionId: 'session-1',
            mode: 'write',
            clientId: 'raw-test',
            client,
        });
        expect(await attachment.readScreenText()).toBe('picker');
        expect((await attachment.readState()).cursor).toEqual({ row: 2, col: 3 });
        await attachment.writeKeys(['down', 'enter']);
        await attachment.close();

        expect(requests.map(request => request.type)).toEqual([
            'attach_session',
            'acquire_write',
            'get_terminal_snapshot',
            'get_terminal_snapshot',
            'send_input',
            'release_write',
            'detach_session',
        ]);
        const send = requests.find(request => request.type === 'send_input');
        expect(send?.payload.data).toBe('\x1b[B\r');
    });
});
