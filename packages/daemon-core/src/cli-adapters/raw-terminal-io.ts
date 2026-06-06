import { randomUUID } from 'crypto';
import {
    SessionHostClient,
    type SessionHostEndpoint,
    type SessionHostRequest,
    type SessionHostResponse,
    type SessionTerminalSnapshot,
    type SessionTerminalState,
} from '@adhdev/session-host-core';

type LowercaseLetter =
    | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
    | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';

type FunctionKey = 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12';
type BaseNamedKey =
    | 'enter' | 'escape' | 'tab' | 'backspace'
    | 'up' | 'down' | 'left' | 'right'
    | 'home' | 'end' | 'pageup' | 'pagedown' | 'space'
    | FunctionKey;
type ShiftNamedKey = BaseNamedKey | LowercaseLetter | `ctrl+${LowercaseLetter}` | `alt+${LowercaseLetter}`;

export type NamedKey =
    | BaseNamedKey
    | `ctrl+${LowercaseLetter}`
    | `alt+${LowercaseLetter}`
    | `shift+${ShiftNamedKey}`;

const BASE_KEY_SEQUENCES: Record<BaseNamedKey, string> = {
    enter: '\r',
    escape: '\x1b',
    tab: '\t',
    backspace: '\x7f',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    home: '\x1b[H',
    end: '\x1b[F',
    pageup: '\x1b[5~',
    pagedown: '\x1b[6~',
    space: ' ',
    f1: '\x1bOP',
    f2: '\x1bOQ',
    f3: '\x1bOR',
    f4: '\x1bOS',
    f5: '\x1b[15~',
    f6: '\x1b[17~',
    f7: '\x1b[18~',
    f8: '\x1b[19~',
    f9: '\x1b[20~',
    f10: '\x1b[21~',
    f11: '\x1b[23~',
    f12: '\x1b[24~',
};

const SHIFTED_CSI_KEYS: Partial<Record<BaseNamedKey, string>> = {
    up: '\x1b[1;2A',
    down: '\x1b[1;2B',
    right: '\x1b[1;2C',
    left: '\x1b[1;2D',
    home: '\x1b[1;2H',
    end: '\x1b[1;2F',
    pageup: '\x1b[5;2~',
    pagedown: '\x1b[6;2~',
    f1: '\x1b[1;2P',
    f2: '\x1b[1;2Q',
    f3: '\x1b[1;2R',
    f4: '\x1b[1;2S',
    f5: '\x1b[15;2~',
    f6: '\x1b[17;2~',
    f7: '\x1b[18;2~',
    f8: '\x1b[19;2~',
    f9: '\x1b[20;2~',
    f10: '\x1b[21;2~',
    f11: '\x1b[23;2~',
    f12: '\x1b[24;2~',
};

function isLowercaseLetter(value: string): value is LowercaseLetter {
    return /^[a-z]$/.test(value);
}

function encodeControlLetter(letter: LowercaseLetter): string {
    return String.fromCharCode(letter.charCodeAt(0) - 96);
}

function encodeShiftedKey(key: string): string {
    if (isLowercaseLetter(key)) return key.toUpperCase();
    if (key.startsWith('ctrl+') && isLowercaseLetter(key.slice(5))) {
        return encodeControlLetter(key.slice(5) as LowercaseLetter);
    }
    if (key.startsWith('alt+') && isLowercaseLetter(key.slice(4))) {
        return `\x1b${key.slice(4).toUpperCase()}`;
    }
    if (key === 'tab') return '\x1b[Z';
    if (key in SHIFTED_CSI_KEYS) return SHIFTED_CSI_KEYS[key as BaseNamedKey]!;
    if (key in BASE_KEY_SEQUENCES) return BASE_KEY_SEQUENCES[key as BaseNamedKey];
    throw new Error(`Unsupported named key: shift+${key}`);
}

export function namedKeyToAnsi(key: NamedKey | string): string {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized in BASE_KEY_SEQUENCES) return BASE_KEY_SEQUENCES[normalized as BaseNamedKey];
    if (normalized.startsWith('ctrl+') && isLowercaseLetter(normalized.slice(5))) {
        return encodeControlLetter(normalized.slice(5) as LowercaseLetter);
    }
    if (normalized.startsWith('alt+') && isLowercaseLetter(normalized.slice(4))) {
        return `\x1b${normalized.slice(4)}`;
    }
    if (normalized.startsWith('shift+')) return encodeShiftedKey(normalized.slice(6));
    throw new Error(`Unsupported named key: ${key}`);
}

export function namedKeysToAnsi(keys: readonly (NamedKey | string)[]): string {
    if (!Array.isArray(keys)) throw new Error('keys must be an array');
    return keys.map(namedKeyToAnsi).join('');
}

export interface RawTerminalSessionHostClient {
    connect(): Promise<void>;
    request<T = unknown>(request: SessionHostRequest): Promise<SessionHostResponse<T>>;
    close(): Promise<void>;
}

export interface RawTerminalAttachmentOptions {
    endpoint?: SessionHostEndpoint;
    sessionId: string;
    mode?: 'read' | 'write';
    clientId?: string;
    client?: RawTerminalSessionHostClient;
}

export class RawTerminalAttachment {
    private closed = false;

    private constructor(
        readonly sessionId: string,
        private readonly clientId: string,
        private readonly mode: 'read' | 'write',
        private readonly client: RawTerminalSessionHostClient,
    ) {}

    static async attach(options: RawTerminalAttachmentOptions): Promise<RawTerminalAttachment> {
        const sessionId = String(options.sessionId || '').trim();
        if (!sessionId) throw new Error('sessionId is required');
        const mode = options.mode || 'read';
        const clientId = options.clientId || `raw-terminal-${process.pid}-${randomUUID().slice(0, 8)}`;
        const client = options.client || new SessionHostClient({ endpoint: options.endpoint });
        await client.connect();

        const attachResponse = await client.request({
            type: 'attach_session',
            payload: {
                sessionId,
                clientId,
                clientType: 'web',
                readOnly: mode === 'read',
            },
        });
        if (!attachResponse.success) {
            await client.close().catch(() => {});
            throw new Error(attachResponse.error || `Failed to attach terminal session ${sessionId}`);
        }

        if (mode === 'write') {
            const ownerResponse = await client.request({
                type: 'acquire_write',
                payload: {
                    sessionId,
                    clientId,
                    ownerType: 'user',
                    force: true,
                },
            });
            if (!ownerResponse.success) {
                await client.request({
                    type: 'detach_session',
                    payload: { sessionId, clientId },
                }).catch(() => ({ success: false }));
                await client.close().catch(() => {});
                throw new Error(ownerResponse.error || `Failed to acquire terminal session ${sessionId}`);
            }
        }

        return new RawTerminalAttachment(sessionId, clientId, mode, client);
    }

    async readSnapshot(): Promise<SessionTerminalSnapshot> {
        const response = await this.client.request<SessionTerminalSnapshot>({
            type: 'get_terminal_snapshot',
            payload: { sessionId: this.sessionId },
        });
        if (!response.success || !response.result) {
            throw new Error(response.error || `Terminal screen unavailable for ${this.sessionId}`);
        }
        return response.result;
    }

    async readScreenText(): Promise<string> {
        return (await this.readSnapshot()).text;
    }

    async readState(): Promise<SessionTerminalState> {
        return (await this.readSnapshot()).state;
    }

    async writeInput(text: string): Promise<void> {
        if (this.mode !== 'write') throw new Error('Raw terminal attachment is read-only');
        const response = await this.client.request({
            type: 'send_input',
            payload: {
                sessionId: this.sessionId,
                clientId: this.clientId,
                data: text,
            },
        });
        if (!response.success) throw new Error(response.error || `Failed to write terminal input to ${this.sessionId}`);
    }

    async writeKeys(keys: readonly (NamedKey | string)[]): Promise<void> {
        await this.writeInput(namedKeysToAnsi(keys));
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.mode === 'write') {
            await this.client.request({
                type: 'release_write',
                payload: { sessionId: this.sessionId, clientId: this.clientId },
            }).catch(() => ({ success: false }));
        }
        await this.client.request({
            type: 'detach_session',
            payload: { sessionId: this.sessionId, clientId: this.clientId },
        }).catch(() => ({ success: false }));
        await this.client.close().catch(() => {});
    }
}

export async function withRawTerminalAttachment<T>(
    options: RawTerminalAttachmentOptions,
    operation: (attachment: RawTerminalAttachment) => Promise<T>,
): Promise<T> {
    const attachment = await RawTerminalAttachment.attach(options);
    try {
        return await operation(attachment);
    } finally {
        await attachment.close();
    }
}
