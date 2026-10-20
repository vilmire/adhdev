/**
 * TOML 1.0 parser, semantic validator, server-identity guard, and AST-span
 * surgical updater for `<workspace>/.codex/config.toml`.
 *
 * - Parses the TOML 1.0 grammar used by Codex configs (matching Python 3.14
 *   `tomllib` table/array-of-tables scoping and RFC 3339 calendar/time
 *   validation with seconds `00..59`), recording exact character spans for
 *   surgical in-place updates without whole-document reformatting.
 * - Verifies exact command + entrypoint + track + transport + daemon identity
 *   before preserving `tools.*` consent, and leaves the file byte-for-byte
 *   untouched (`next === before`) on ordinary relaunches.
 */

import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ASSISTANT_SESSION_ID_ENV } from '@adhdev/mesh-shared';

export interface AssistantCodexMcpServerSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

export type TomlDateTimeKind = 'offset-date-time' | 'local-date-time' | 'local-date' | 'local-time';

const TOML_DATETIME_BRAND = Symbol('TomlDateTime');
const tomlDateTimeInstances = new WeakSet<object>();

export class TomlDateTimeValue {
    readonly [TOML_DATETIME_BRAND] = true;
    readonly __tomlType: TomlDateTimeKind;
    readonly raw: string;

    constructor(kind: TomlDateTimeKind, raw: string) {
        this.__tomlType = kind;
        this.raw = raw;
        tomlDateTimeInstances.add(this);
        Object.freeze(this);
    }
}

export function isTomlDateTimeValue(value: unknown): value is TomlDateTimeValue {
    return typeof value === 'object' && value !== null && tomlDateTimeInstances.has(value);
}

interface TomlAssignmentSpan {
    keyPath: string[];
    fullPath: string[];
    value: unknown;
    lineStart: number;
    lineEnd: number;
    valueStart: number;
    valueEnd: number;
}

interface TomlSectionSpan {
    headerPath: string[];
    isArrayTable: boolean;
    headerLineStart: number;
    headerLineEnd: number;
    sectionEnd: number;
    assignments: TomlAssignmentSpan[];
}

export interface ParsedTomlDocument {
    root: Record<string, any>;
    sections: TomlSectionSpan[];
    inlineTables: WeakSet<object>;
    arrayOfTables: WeakSet<Array<any>>;
}

const UNSAFE_ENV_OVERRIDE_KEYS = new Set([
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'ADHDEV_COORDINATOR_MCP_ENTRY_PATH',
    'ADHDEV_COORDINATOR_MCP_COMMAND',
    'ADHDEV_COORDINATOR_MCP_PORT',
    'ADHDEV_COORDINATOR_MCP_TRANSPORT',
    'ADHDEV_COORDINATOR_NODE_EXECUTABLE',
]);

const NON_STDIO_MCP_KEYS = new Set(['url', 'bearer_token_env_var', 'http_headers', 'env_http_headers']);

function isPlainTable(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && !isTomlDateTimeValue(value);
}

function createTable(): Record<string, any> {
    return Object.create(null) as Record<string, any>;
}

export function formatTomlSegment(segment: string): string {
    return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

/** Return a copy of `server` with the per-session `ADHDEV_ASSISTANT_SESSION_ID` key removed from `env`. */
export function withoutAssistantSessionEnv<T extends AssistantCodexMcpServerSpec>(server: T): T {
    if (!server.env) return { command: server.command, args: [...server.args] } as T;
    const nextEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
        if (k !== ASSISTANT_SESSION_ID_ENV) nextEnv[k] = v;
    }
    if (Object.keys(nextEnv).length === 0) return { command: server.command, args: [...server.args] } as T;
    return { command: server.command, args: [...server.args], env: nextEnv } as T;
}

function invalidToml(message: string): Error {
    return new Error(`assistant_codex_config_invalid_toml: ${message}`);
}

function foreignServerError(message: string): Error {
    return new Error(`assistant_codex_config_foreign_server: ${message}`);
}

const FLAG_FROZEN = 0;
const FLAG_EXPLICIT_NEST = 1;

interface FlagEntry {
    flags: Set<number>;
    recursiveFlags: Set<number>;
    nested: Map<string, FlagEntry>;
}

function createFlagEntry(): FlagEntry {
    return { flags: new Set<number>(), recursiveFlags: new Set<number>(), nested: new Map<string, FlagEntry>() };
}

/**
 * Namespace flag tracker modeled directly after Python 3.14 `tomllib._parser.Flags`.
 * `unsetAll(key)` frees the sub-namespace whenever a new `[[array_of_tables]]`
 * element is opened, while keeping `key` itself marked `EXPLICIT_NEST` against `[key]`.
 */
class TomlFlags {
    private readonly root = new Map<string, FlagEntry>();
    private readonly pending: Array<{ key: readonly string[]; flag: number }> = [];

    addPending(key: readonly string[], flag: number): void {
        this.pending.push({ key, flag });
    }

    finalizePending(): void {
        for (const item of this.pending) this.set(item.key, item.flag, false);
        this.pending.length = 0;
    }

    unsetAll(key: readonly string[]): void {
        if (key.length === 0) return;
        let cont = this.root;
        for (let i = 0; i < key.length - 1; i++) {
            const entry = cont.get(key[i]);
            if (!entry) return;
            cont = entry.nested;
        }
        cont.delete(key[key.length - 1]);
    }

    set(key: readonly string[], flag: number, recursive: boolean): void {
        if (key.length === 0) return;
        let cont = this.root;
        for (let i = 0; i < key.length - 1; i++) {
            const seg = key[i];
            let entry = cont.get(seg);
            if (!entry) {
                entry = createFlagEntry();
                cont.set(seg, entry);
            }
            cont = entry.nested;
        }
        const stem = key[key.length - 1];
        let stemEntry = cont.get(stem);
        if (!stemEntry) {
            stemEntry = createFlagEntry();
            cont.set(stem, stemEntry);
        }
        if (recursive) stemEntry.recursiveFlags.add(flag);
        else stemEntry.flags.add(flag);
    }

    is(key: readonly string[], flag: number): boolean {
        if (key.length === 0) return false;
        let cont = this.root;
        for (let i = 0; i < key.length - 1; i++) {
            const entry = cont.get(key[i]);
            if (!entry) return false;
            if (entry.recursiveFlags.has(flag)) return true;
            cont = entry.nested;
        }
        const stemEntry = cont.get(key[key.length - 1]);
        if (!stemEntry) return false;
        return stemEntry.flags.has(flag) || stemEntry.recursiveFlags.has(flag);
    }
}

function isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
    if (month < 1 || month > 12) return 0;
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function parseTomlDateOrTime(rawToken: string): TomlDateTimeValue | null {
    if (rawToken.includes(':')) {
        const localTimeMatch = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(rawToken);
        if (localTimeMatch) {
            const hour = Number(localTimeMatch[1]);
            const minute = Number(localTimeMatch[2]);
            const second = Number(localTimeMatch[3]);
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
                throw invalidToml(`invalid local time ${JSON.stringify(rawToken)}`);
            }
            return new TomlDateTimeValue('local-time', rawToken);
        }
    }

    if (/^\d{4}-/.test(rawToken)) {
        const dtMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))?)?$/.exec(rawToken);
        if (!dtMatch) throw invalidToml(`invalid date or datetime ${JSON.stringify(rawToken)}`);
        const year = Number(dtMatch[1]);
        const month = Number(dtMatch[2]);
        const day = Number(dtMatch[3]);
        const maxDay = daysInMonth(year, month);
        if (month < 1 || month > 12 || day < 1 || day > maxDay) {
            throw invalidToml(`invalid calendar date in ${JSON.stringify(rawToken)}`);
        }
        if (dtMatch[4] === undefined) return new TomlDateTimeValue('local-date', rawToken);
        const hour = Number(dtMatch[4]);
        const minute = Number(dtMatch[5]);
        const second = Number(dtMatch[6]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
            throw invalidToml(`invalid time in datetime ${JSON.stringify(rawToken)}`);
        }
        if (dtMatch[9] !== undefined) {
            const offsetHour = Number(dtMatch[10]);
            const offsetMinute = Number(dtMatch[11]);
            if (offsetHour < 0 || offsetHour > 23 || offsetMinute < 0 || offsetMinute > 59) {
                throw invalidToml(`invalid timezone offset in ${JSON.stringify(rawToken)}`);
            }
            return new TomlDateTimeValue('offset-date-time', rawToken);
        }
        if (dtMatch[8] !== undefined) return new TomlDateTimeValue('offset-date-time', rawToken);
        return new TomlDateTimeValue('local-date-time', rawToken);
    }

    return null;
}

/**
 * Full TOML 1.0 recursive-descent parser with exact character span tracking.
 * Rejects syntax errors, unclosed strings/arrays/inline tables, duplicate keys,
 * duplicate table headers, invalid calendar dates/times, and table/scalar/inline-table
 * type conflicts while properly scoping `[[array_of_tables]]` instances.
 */
export function parseTomlDocument(source: string): ParsedTomlDocument {
    if (source.includes('\0')) throw invalidToml('null byte in TOML input');

    const len = source.length;
    let pos = 0;

    const root = createTable();
    const flags = new TomlFlags();
    const inlineTables = new WeakSet<object>();
    const arrayOfTables = new WeakSet<Array<any>>();

    const preamble: TomlSectionSpan = {
        headerPath: [],
        isArrayTable: false,
        headerLineStart: 0,
        headerLineEnd: 0,
        sectionEnd: len,
        assignments: [],
    };
    const sections: TomlSectionSpan[] = [preamble];
    let currentSection: TomlSectionSpan = preamble;

    const isHws = (ch: string) => ch === ' ' || ch === '\t';
    const isNewline = (ch: string) => ch === '\n' || ch === '\r';
    const skipHws = () => {
        while (pos < len && isHws(source[pos])) pos++;
    };

    const skipCommentToLineEnd = () => {
        if (pos < len && source[pos] === '#') {
            pos++;
            while (pos < len && !isNewline(source[pos])) {
                const code = source.charCodeAt(pos);
                if ((code >= 0 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
                    throw invalidToml(`invalid control character U+${code.toString(16).padStart(4, '0')} in comment`);
                }
                pos++;
            }
        }
    };

    const consumeLineEndingOrEof = (context: string) => {
        skipHws();
        skipCommentToLineEnd();
        if (pos >= len) return;
        if (source[pos] === '\r') {
            pos++;
            if (pos >= len || source[pos] !== '\n') throw invalidToml(`bare CR without LF after ${context}`);
            pos++;
            return;
        }
        if (source[pos] === '\n') {
            pos++;
            return;
        }
        throw invalidToml(`unexpected token ${JSON.stringify(source[pos])} after ${context}`);
    };

    const getOrCreateNest = (
        baseDict: Record<string, any>,
        key: readonly string[],
        accessLists: boolean,
        markInline = false,
    ): Record<string, any> => {
        let cont: any = baseDict;
        for (const k of key) {
            if (!(k in cont)) {
                const created = createTable();
                if (markInline) inlineTables.add(created);
                cont[k] = created;
            }
            cont = cont[k];
            if (accessLists && Array.isArray(cont)) {
                if (!arrayOfTables.has(cont) || cont.length === 0) {
                    throw invalidToml(`cannot traverse static array at ${key.join('.')}`);
                }
                cont = cont[cont.length - 1];
            }
            if (!isPlainTable(cont)) throw invalidToml(`cannot overwrite non-table key in ${key.join('.')}`);
        }
        return cont;
    };

    const appendNestToList = (key: readonly string[]): Record<string, any> => {
        const cont = getOrCreateNest(root, key.slice(0, -1), true);
        const lastKey = key[key.length - 1];
        if (lastKey in cont) {
            const list = cont[lastKey];
            if (!Array.isArray(list) || !arrayOfTables.has(list)) {
                throw invalidToml(`cannot overwrite non-array-of-tables key at [[${key.join('.')}]]`);
            }
            const elem = createTable();
            list.push(elem);
            return elem;
        }
        const elem = createTable();
        const list = [elem];
        arrayOfTables.add(list);
        cont[lastKey] = list;
        return elem;
    };

    const parseEscape = (allowMultilineContinuations: boolean): string => {
        if (pos >= len) throw invalidToml('unterminated escape sequence');
        const ch = source[pos++];
        switch (ch) {
            case 'b': return '\b';
            case 't': return '\t';
            case 'n': return '\n';
            case 'f': return '\f';
            case 'r': return '\r';
            case '"': return '"';
            case '\\': return '\\';
            case 'u': {
                const hex = source.slice(pos, pos + 4);
                if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw invalidToml(`invalid \\u escape: \\u${hex}`);
                pos += 4;
                const cp = parseInt(hex, 16);
                if (cp >= 0xd800 && cp <= 0xdfff) throw invalidToml(`invalid surrogate scalar \\u${hex}`);
                return String.fromCodePoint(cp);
            }
            case 'U': {
                const hex = source.slice(pos, pos + 8);
                if (!/^[0-9A-Fa-f]{8}$/.test(hex)) throw invalidToml(`invalid \\U escape: \\U${hex}`);
                pos += 8;
                const cp = parseInt(hex, 16);
                if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw invalidToml(`invalid Unicode scalar \\U${hex}`);
                return String.fromCodePoint(cp);
            }
            default: {
                if (allowMultilineContinuations && (isHws(ch) || isNewline(ch))) {
                    pos--;
                    skipHws();
                    if (pos < len && source[pos] === '\r') pos++;
                    if (pos >= len || source[pos] !== '\n') {
                        throw invalidToml('invalid line-ending backslash escape in multiline string');
                    }
                    pos++;
                    while (pos < len && (isHws(source[pos]) || isNewline(source[pos]))) {
                        if (source[pos] === '\r' && source[pos + 1] !== '\n') throw invalidToml('bare CR in multiline string');
                        pos++;
                    }
                    return '';
                }
                throw invalidToml(`invalid escape sequence \\${ch}`);
            }
        }
    };

    const parseBasicString = (allowMultiline: boolean): string => {
        if (allowMultiline && source.startsWith('"""', pos)) {
            pos += 3;
            if (source[pos] === '\r' && source[pos + 1] === '\n') pos += 2;
            else if (source[pos] === '\n') pos += 1;
            let out = '';
            while (pos < len) {
                if (source.startsWith('"""', pos)) {
                    let quoteCount = 0;
                    while (pos + quoteCount < len && source[pos + quoteCount] === '"' && quoteCount < 6) quoteCount++;
                    if (quoteCount >= 6) throw invalidToml('too many consecutive quotes in multiline basic string');
                    out += '"'.repeat(quoteCount - 3);
                    pos += quoteCount;
                    return out;
                }
                const ch = source[pos++];
                if (ch === '\\') {
                    out += parseEscape(true);
                } else if (ch === '\r') {
                    if (source[pos] !== '\n') throw invalidToml('bare CR in multiline basic string');
                    pos++;
                    out += '\n';
                } else {
                    const code = ch.charCodeAt(0);
                    if ((code >= 0 && code <= 0x08) || (code >= 0x0b && code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
                        throw invalidToml('invalid control character in multiline basic string');
                    }
                    out += ch;
                }
            }
            throw invalidToml('unterminated multiline basic string');
        }

        pos++; // consume opening "
        let out = '';
        while (pos < len) {
            const ch = source[pos++];
            if (ch === '"') return out;
            if (ch === '\\') {
                out += parseEscape(false);
            } else if (isNewline(ch)) {
                throw invalidToml('unterminated basic string before end of line');
            } else {
                const code = ch.charCodeAt(0);
                if ((code >= 0 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
                    throw invalidToml('invalid control character in basic string');
                }
                out += ch;
            }
        }
        throw invalidToml('unterminated basic string');
    };

    const parseLiteralString = (allowMultiline: boolean): string => {
        if (allowMultiline && source.startsWith("'''", pos)) {
            pos += 3;
            if (source[pos] === '\r' && source[pos + 1] === '\n') pos += 2;
            else if (source[pos] === '\n') pos += 1;
            let out = '';
            while (pos < len) {
                if (source.startsWith("'''", pos)) {
                    let quoteCount = 0;
                    while (pos + quoteCount < len && source[pos + quoteCount] === "'" && quoteCount < 6) quoteCount++;
                    if (quoteCount >= 6) throw invalidToml('too many consecutive single quotes in multiline literal string');
                    out += "'".repeat(quoteCount - 3);
                    pos += quoteCount;
                    return out;
                }
                const ch = source[pos++];
                if (ch === '\r') {
                    if (source[pos] !== '\n') throw invalidToml('bare CR in multiline literal string');
                    pos++;
                    out += '\n';
                } else {
                    const code = ch.charCodeAt(0);
                    if ((code >= 0 && code <= 0x08) || (code >= 0x0b && code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
                        throw invalidToml('invalid control character in multiline literal string');
                    }
                    out += ch;
                }
            }
            throw invalidToml('unterminated multiline literal string');
        }

        pos++; // consume opening '
        let out = '';
        while (pos < len) {
            const ch = source[pos++];
            if (ch === "'") return out;
            if (isNewline(ch)) throw invalidToml('unterminated literal string before end of line');
            const code = ch.charCodeAt(0);
            if ((code >= 0 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
                throw invalidToml('invalid control character in literal string');
            }
            out += ch;
        }
        throw invalidToml('unterminated literal string');
    };

    const parseKeySegment = (): string => {
        skipHws();
        if (pos >= len) throw invalidToml('unexpected EOF while reading key');
        const ch = source[pos];
        if (ch === '"') {
            if (source.startsWith('"""', pos)) throw invalidToml('multiline string not allowed as key');
            return parseBasicString(false);
        }
        if (ch === "'") {
            if (source.startsWith("'''", pos)) throw invalidToml('multiline string not allowed as key');
            return parseLiteralString(false);
        }
        const start = pos;
        while (pos < len && /[A-Za-z0-9_-]/.test(source[pos])) pos++;
        if (pos === start) throw invalidToml(`expected key segment at offset ${pos}`);
        return source.slice(start, pos);
    };

    const parseKeyPath = (): string[] => {
        const parts: string[] = [parseKeySegment()];
        while (pos < len) {
            skipHws();
            if (pos < len && source[pos] === '.') {
                pos++;
                parts.push(parseKeySegment());
            } else {
                break;
            }
        }
        return parts;
    };

    const skipArrayWsAndComments = () => {
        while (pos < len) {
            if (isHws(source[pos]) || source[pos] === '\n') {
                pos++;
            } else if (source[pos] === '\r') {
                pos++;
                if (pos >= len || source[pos] !== '\n') throw invalidToml('bare CR inside array');
                pos++;
            } else if (source[pos] === '#') {
                skipCommentToLineEnd();
            } else {
                break;
            }
        }
    };

    const parseValue = (): unknown => {
        skipHws();
        if (pos >= len) throw invalidToml('expected value before EOF');
        const ch = source[pos];
        if (ch === '"') return parseBasicString(true);
        if (ch === "'") return parseLiteralString(true);
        if (ch === '[') {
            pos++; // consume [
            const arr: unknown[] = [];
            skipArrayWsAndComments();
            if (pos < len && source[pos] === ']') {
                pos++;
                return arr;
            }
            while (pos < len) {
                arr.push(parseValue());
                skipArrayWsAndComments();
                if (pos < len && source[pos] === ',') {
                    pos++;
                    skipArrayWsAndComments();
                    if (pos < len && source[pos] === ']') {
                        pos++;
                        return arr;
                    }
                    continue;
                }
                if (pos < len && source[pos] === ']') {
                    pos++;
                    return arr;
                }
                throw invalidToml(`expected ',' or ']' inside array at offset ${pos}`);
            }
            throw invalidToml('unterminated array');
        }
        if (ch === '{') {
            pos++; // consume {
            const tbl = createTable();
            inlineTables.add(tbl);
            const inlineFlags = new TomlFlags();
            skipHws();
            if (pos < len && source[pos] === '}') {
                pos++;
                return tbl;
            }
            while (pos < len) {
                const kPath = parseKeyPath();
                skipHws();
                if (pos >= len || source[pos] !== '=') throw invalidToml(`expected '=' in inline table at offset ${pos}`);
                pos++;
                const val = parseValue();
                const keyParent = kPath.slice(0, -1);
                const keyStem = kPath[kPath.length - 1];
                if (inlineFlags.is(kPath, FLAG_FROZEN)) {
                    throw invalidToml(`cannot mutate immutable namespace ${kPath.join('.')} in inline table`);
                }
                const nest = getOrCreateNest(tbl, keyParent, false, true);
                if (keyStem in nest) throw invalidToml(`duplicate key ${kPath.join('.')} in inline table`);
                nest[keyStem] = val;
                skipHws();
                if (pos < len && source[pos] === '}') {
                    pos++;
                    return tbl;
                }
                if (pos >= len || source[pos] !== ',') throw invalidToml(`expected ',' or '}' in inline table at offset ${pos}`);
                if (isPlainTable(val) || Array.isArray(val)) inlineFlags.set(kPath, FLAG_FROZEN, true);
                pos++; // consume ,
                skipHws();
                if (pos < len && source[pos] === '}') throw invalidToml('trailing comma not permitted in TOML 1.0 inline table');
            }
            throw invalidToml('unterminated inline table');
        }

        // Scalar token: boolean, date/time/datetime, integer, or float
        const start = pos;
        while (pos < len && !isHws(source[pos]) && !isNewline(source[pos]) && source[pos] !== '#' && source[pos] !== ',' && source[pos] !== ']' && source[pos] !== '}') {
            pos++;
        }
        let rawToken = source.slice(start, pos);
        if (/^\d{4}-\d{2}-\d{2}$/.test(rawToken) && pos < len && source[pos] === ' ' && /^\d{2}:\d{2}/.test(source.slice(pos + 1))) {
            pos++; // consume single space
            const tStart = pos;
            while (pos < len && !isHws(source[pos]) && !isNewline(source[pos]) && source[pos] !== '#' && source[pos] !== ',' && source[pos] !== ']' && source[pos] !== '}') {
                pos++;
            }
            rawToken += ` ${source.slice(tStart, pos)}`;
        }
        if (!rawToken) throw invalidToml(`unexpected character at offset ${pos}`);
        if (rawToken === 'true') return true;
        if (rawToken === 'false') return false;

        const dtValue = parseTomlDateOrTime(rawToken);
        if (dtValue !== null) return dtValue;

        if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(rawToken)) return Number(rawToken.replace(/_/g, ''));
        if (/^0x[0-9a-fA-F](?:_?[0-9a-fA-F])*$/.test(rawToken)
            || /^0o[0-7](?:_?[0-7])*$/.test(rawToken)
            || /^0b[01](?:_?[01])*$/.test(rawToken)) {
            return Number(rawToken.replace(/_/g, ''));
        }
        if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(rawToken)) {
            return Number(rawToken.replace(/_/g, ''));
        }
        if (/^[+-]?(?:inf|nan)$/.test(rawToken)) {
            if (rawToken.endsWith('nan')) return NaN;
            return rawToken.startsWith('-') ? -Infinity : Infinity;
        }
        throw invalidToml(`invalid scalar value ${JSON.stringify(rawToken)}`);
    };

    const openDictHeader = (headerPath: string[]): void => {
        if (flags.is(headerPath, FLAG_EXPLICIT_NEST) || flags.is(headerPath, FLAG_FROZEN)) {
            throw invalidToml(`duplicate or conflicting table header [${headerPath.join('.')}]`);
        }
        flags.set(headerPath, FLAG_EXPLICIT_NEST, false);
        const target = getOrCreateNest(root, headerPath, true);
        if (Array.isArray(target)) throw invalidToml(`conflicting table header [${headerPath.join('.')}]`);
    };

    const openListHeader = (headerPath: string[]): void => {
        if (flags.is(headerPath, FLAG_FROZEN)) {
            throw invalidToml(`cannot mutate immutable namespace [[${headerPath.join('.')}]]`);
        }
        flags.unsetAll(headerPath);
        flags.set(headerPath, FLAG_EXPLICIT_NEST, false);
        appendNestToList(headerPath);
    };

    const assignIntoSection = (sectionPath: string[], keyPath: string[], value: unknown): void => {
        const keyParent = keyPath.slice(0, -1);
        const keyStem = keyPath[keyPath.length - 1];
        const absKeyParent = [...sectionPath, ...keyParent];

        for (let i = 1; i < keyPath.length; i++) {
            const contKey = [...sectionPath, ...keyPath.slice(0, i)];
            if (flags.is(contKey, FLAG_EXPLICIT_NEST)) {
                throw invalidToml(`cannot redefine table ${contKey.join('.')} via dotted key`);
            }
            flags.addPending(contKey, FLAG_EXPLICIT_NEST);
        }

        if (flags.is(absKeyParent, FLAG_FROZEN)) {
            throw invalidToml(`cannot extend inline or frozen value at ${absKeyParent.join('.')}`);
        }

        const nest = getOrCreateNest(root, absKeyParent, true);
        if (keyStem in nest) {
            throw invalidToml(`duplicate or conflicting key ${[...sectionPath, ...keyPath].join('.')}`);
        }
        if (isPlainTable(value) || Array.isArray(value)) {
            flags.set([...sectionPath, ...keyPath], FLAG_FROZEN, true);
        }
        nest[keyStem] = value;
    };

    while (pos < len) {
        const lineStart = pos;
        skipHws();
        if (pos >= len) break;
        const ch = source[pos];
        if (ch === '#') {
            consumeLineEndingOrEof('comment');
            continue;
        }
        if (ch === '\r' || ch === '\n') {
            consumeLineEndingOrEof('blank line');
            continue;
        }
        if (ch === '[') {
            currentSection.sectionEnd = lineStart;
            flags.finalizePending();
            const isArrayTable = source.startsWith('[[', pos);
            pos += isArrayTable ? 2 : 1;
            skipHws();
            if (pos < len && source[pos] === ']') throw invalidToml('empty table header []');
            const headerPath = parseKeyPath();
            skipHws();
            if (isArrayTable) {
                if (!source.startsWith(']]', pos)) throw invalidToml('expected closing ]] for array-of-tables header');
                pos += 2;
            } else {
                if (pos >= len || source[pos] !== ']') throw invalidToml('expected closing ] for table header');
                pos += 1;
            }
            consumeLineEndingOrEof('table header');
            const headerLineEnd = pos;
            if (isArrayTable) openListHeader(headerPath);
            else openDictHeader(headerPath);
            currentSection = {
                headerPath,
                isArrayTable,
                headerLineStart: lineStart,
                headerLineEnd,
                sectionEnd: len,
                assignments: [],
            };
            sections.push(currentSection);
            continue;
        }

        const keyPath = parseKeyPath();
        skipHws();
        if (pos >= len || source[pos] !== '=') throw invalidToml(`expected '=' after key ${keyPath.join('.')}`);
        pos++; // consume =
        skipHws();
        const valueStart = pos;
        const value = parseValue();
        const valueEnd = pos;
        consumeLineEndingOrEof(`assignment to ${keyPath.join('.')}`);
        const lineEnd = pos;

        assignIntoSection(currentSection.headerPath, keyPath, value);
        currentSection.assignments.push({
            keyPath,
            fullPath: [...currentSection.headerPath, ...keyPath],
            value,
            lineStart,
            lineEnd,
            valueStart,
            valueEnd,
        });
    }

    currentSection.sectionEnd = len;
    return { root, sections, inlineTables, arrayOfTables };
}

export interface ManagedAssistantServerIdentity {
    kind: 'adhdev-cli' | 'adhdev-mcp-bin' | 'node-entry';
    track: 'adhdev' | 'adhdev-preview';
    command: string;
    entrypoint: string;
    mode: 'ipc' | 'local';
    port: number | null;
    daemonUrl: string | null;
}

/**
 * Inspect a parsed `mcp_servers.<name>` table and extract its exact ADHDev
 * assistant MCP server identity. Both `command` and `entrypoint` are recorded
 * verbatim so any foreign installation path or foreign Node binary fails closed.
 */
export function parseManagedAssistantServerIdentity(
    entry: Record<string, any>,
): { ok: true; value: ManagedAssistantServerIdentity } | { ok: false; reason: string } {
    for (const key of Object.keys(entry)) {
        if (NON_STDIO_MCP_KEYS.has(key)) {
            return { ok: false, reason: `non-stdio MCP transport key "${key}" is not a managed assistant server` };
        }
    }
    if (
        typeof entry.command !== 'string'
        || entry.command.length === 0
        || entry.command.trim() !== entry.command
        || entry.command.endsWith('/')
        || entry.command.endsWith('\\')
    ) {
        return { ok: false, reason: 'missing, non-string, or whitespace/slash-padded MCP server command (orphan or non-stdio entry)' };
    }
    if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) {
        return { ok: false, reason: 'missing or non-string-array MCP server args' };
    }

    const command = entry.command;
    const args: string[] = entry.args;
    const cmdBase = basename(command.replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '');

    let kind: ManagedAssistantServerIdentity['kind'];
    let track: ManagedAssistantServerIdentity['track'];
    let entrypoint: string;
    let restArgs: string[];

    if ((cmdBase === 'adhdev' || cmdBase === 'adhdev-preview') && args[0] === 'mcp') {
        kind = 'adhdev-cli';
        track = cmdBase;
        entrypoint = 'mcp';
        restArgs = args.slice(1);
    } else if (cmdBase.startsWith('adhdev-mcp') || command.includes('/vendor/mcp-server/') || command.includes('\\vendor\\mcp-server\\')) {
        kind = 'adhdev-mcp-bin';
        track = cmdBase.includes('preview') || command.includes('adhdev-preview') ? 'adhdev-preview' : 'adhdev';
        entrypoint = command;
        restArgs = args;
    } else if ((cmdBase === 'node' || cmdBase === 'nodejs') && args.length >= 1 && !args[0].startsWith('-')) {
        const script = args[0];
        if (!script || script.trim() !== script || script.endsWith('/') || script.endsWith('\\')) {
            return { ok: false, reason: `invalid or whitespace-padded node entrypoint "${script}"` };
        }
        if (!/(?:^|[\\/])(?:mcp-server|adhdev-mcp|fixture-mcp-server)/i.test(script)) {
            return { ok: false, reason: `unrecognized node entrypoint "${script}"` };
        }
        kind = 'node-entry';
        track = script.includes('adhdev-preview') ? 'adhdev-preview' : 'adhdev';
        entrypoint = script;
        restArgs = args.slice(1);
    } else {
        return { ok: false, reason: `unrecognized MCP server command "${command}"` };
    }

    let hasAssistant = false;
    let hasAuthFile = false;
    let mode: 'ipc' | 'local' | null = null;
    let port: number | null = null;

    for (let i = 0; i < restArgs.length; i++) {
        const arg = restArgs[i];
        if (arg === '--assistant') {
            if (hasAssistant) return { ok: false, reason: 'duplicate --assistant flag' };
            hasAssistant = true;
            continue;
        }
        if (arg === '--mode') {
            const val = restArgs[++i];
            if ((val !== 'ipc' && val !== 'local') || mode !== null) {
                return { ok: false, reason: `invalid or duplicate --mode value "${val ?? ''}"` };
            }
            mode = val;
            continue;
        }
        if (arg === '--port') {
            const val = restArgs[++i];
            if (!val || !/^[1-9]\d*$/.test(val) || port !== null) {
                return { ok: false, reason: `invalid or duplicate --port value "${val ?? ''}"` };
            }
            port = Number(val);
            continue;
        }
        if (arg === '--daemon-auth-file') {
            const val = restArgs[++i];
            if (!val || val.trim() !== val || hasAuthFile) {
                return { ok: false, reason: 'missing, whitespace-padded, or duplicate value for --daemon-auth-file' };
            }
            hasAuthFile = true;
            continue;
        }
        return { ok: false, reason: `unrecognized or non-assistant MCP server argument "${arg}"` };
    }

    if (!hasAssistant || !mode) {
        return { ok: false, reason: 'MCP server args must include --assistant and --mode <ipc|local>' };
    }

    const env = isPlainTable(entry.env) ? entry.env : undefined;
    let daemonUrl: string | null = null;
    if (env && 'ADHDEV_DAEMON_URL' in env) {
        const rawUrl = env.ADHDEV_DAEMON_URL;
        if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.trim() !== rawUrl) {
            return { ok: false, reason: 'invalid or whitespace-padded ADHDEV_DAEMON_URL in MCP server env' };
        }
        daemonUrl = rawUrl;
    }

    return { ok: true, value: { kind, track, command, entrypoint, mode, port, daemonUrl } };
}

/**
 * Verify that `existingEntry` in `.codex/config.toml` represents the exact SAME
 * managed ADHDev assistant server installation and daemon identity as `desiredServer`.
 */
export function assertCompatibleAssistantServerIdentity(
    existingEntry: Record<string, any>,
    desiredServer: AssistantCodexMcpServerSpec,
): void {
    if (isPlainTable(existingEntry.env)) {
        for (const [k, v] of Object.entries(existingEntry.env)) {
            if (typeof v !== 'string') throw invalidToml(`mcp_servers env key "${k}" must be a string`);
        }
    }

    const desiredIdentity = parseManagedAssistantServerIdentity(desiredServer);
    if (!desiredIdentity.ok) {
        throw foreignServerError(`target server is not a recognized ADHDev assistant MCP server (${desiredIdentity.reason})`);
    }
    const existingIdentity = parseManagedAssistantServerIdentity(existingEntry);
    if (!existingIdentity.ok) {
        throw foreignServerError(`existing [mcp_servers] entry is not a recognized ADHDev assistant server (${existingIdentity.reason})`);
    }

    const a = existingIdentity.value;
    const b = desiredIdentity.value;
    if (
        existingEntry.command !== desiredServer.command
        || a.kind !== b.kind
        || a.track !== b.track
        || a.command !== b.command
        || a.entrypoint !== b.entrypoint
    ) {
        throw foreignServerError(
            `existing server command/entrypoint (${a.kind}:${a.command}:${a.entrypoint}) does not match target (${b.kind}:${b.command}:${b.entrypoint})`,
        );
    }
    if (a.mode !== b.mode) {
        throw foreignServerError(`existing server transport mode (${a.mode}) does not match target (${b.mode})`);
    }
    if (a.port !== b.port) {
        throw foreignServerError(`existing server daemon port (${a.port ?? 'default'}) does not match target (${b.port ?? 'default'})`);
    }
    if (a.daemonUrl !== b.daemonUrl) {
        throw foreignServerError(`existing server ADHDEV_DAEMON_URL (${a.daemonUrl ?? 'none'}) does not match target (${b.daemonUrl ?? 'none'})`);
    }

    if (isPlainTable(existingEntry.env)) {
        const desiredEnv = desiredServer.env ?? {};
        for (const [k, v] of Object.entries(existingEntry.env)) {
            if (UNSAFE_ENV_OVERRIDE_KEYS.has(k) && desiredEnv[k] !== v) {
                throw foreignServerError(`existing server env contains unsafe override "${k}"`);
            }
        }
    }
}

function sameStringArray(a: unknown, b: readonly string[]): boolean {
    return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameEnvRecord(existingEnv: unknown, desiredEnv: Record<string, string>): boolean {
    const desiredKeys = Object.keys(desiredEnv);
    if (existingEnv === undefined) return desiredKeys.length === 0;
    if (!isPlainTable(existingEnv)) return false;
    const existingKeys = Object.keys(existingEnv);
    return existingKeys.length === desiredKeys.length && desiredKeys.every((k) => existingEnv[k] === desiredEnv[k]);
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function serializeServerBlock(
    seg: string,
    server: AssistantCodexMcpServerSpec,
    envEntries: Array<[string, string]>,
    eol = '\n',
): string {
    const lines = [
        `[mcp_servers.${seg}]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
    ];
    if (envEntries.length > 0) {
        lines.push('', `[mcp_servers.${seg}.env]`);
        for (const [k, v] of envEntries) lines.push(`${formatTomlSegment(k)} = ${JSON.stringify(v)}`);
    }
    return lines.join(eol);
}

interface TextEdit {
    start: number;
    end: number;
    replacement: string;
}

function applyTextEdits(source: string, edits: TextEdit[]): string {
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    let out = source;
    let prevStart = Infinity;
    for (const edit of sorted) {
        if (edit.end > prevStart) throw invalidToml('overlapping AST edits while updating TOML');
        out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
        prevStart = edit.start;
    }
    return out;
}

function stripManagedFieldsForTreeComparison(root: Record<string, any>, serverName: string): Record<string, any> {
    const clone = createTable();
    for (const [k, v] of Object.entries(root)) {
        if (k !== 'mcp_servers' || !isPlainTable(v)) {
            clone[k] = v;
            continue;
        }
        const serversClone = createTable();
        for (const [sk, sv] of Object.entries(v)) {
            if (sk !== serverName || !isPlainTable(sv)) {
                serversClone[sk] = sv;
                continue;
            }
            const managedClone = createTable();
            for (const [mk, mv] of Object.entries(sv)) {
                if (mk !== 'command' && mk !== 'args' && mk !== 'env') managedClone[mk] = mv;
            }
            if (Object.keys(managedClone).length > 0) {
                serversClone[sk] = managedClone;
            }
        }
        if (Object.keys(serversClone).length > 0) {
            clone[k] = serversClone;
        }
    }
    return clone;
}

/**
 * Validate and merge `[mcp_servers.<serverName>]` into `<workspace>/.codex/config.toml`
 * using surgical AST-span edits with zero whole-document whitespace/newline normalization.
 */
export function mergeAssistantCodexMcpConfigToml(
    existingToml: string,
    serverName: string,
    server: AssistantCodexMcpServerSpec,
): string {
    const stableServer = withoutAssistantSessionEnv(server);
    const targetIdentity = parseManagedAssistantServerIdentity(stableServer);
    if (!targetIdentity.ok) {
        throw foreignServerError(`refusing to write unrecognized assistant MCP server config (${targetIdentity.reason})`);
    }

    const seg = formatTomlSegment(serverName);
    const staticEnvEntries = Object.entries(stableServer.env ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));

    if (!existingToml.trim()) {
        const fresh = `${serializeServerBlock(seg, stableServer, staticEnvEntries, '\n')}\n`;
        parseTomlDocument(fresh);
        return fresh;
    }

    const doc = parseTomlDocument(existingToml);
    const eol = existingToml.includes('\r\n') ? '\r\n' : '\n';
    const mcpServers = doc.root.mcp_servers;
    if (mcpServers !== undefined && (!isPlainTable(mcpServers) || doc.inlineTables.has(mcpServers))) {
        throw invalidToml('mcp_servers must be a standard TOML table');
    }

    const existingServer = mcpServers?.[serverName];
    if (existingServer === undefined) {
        const suffix = serializeServerBlock(seg, stableServer, staticEnvEntries, eol);
        const sep = existingToml.endsWith('\n')
            ? (existingToml.endsWith('\r\n\r\n') || existingToml.endsWith('\n\n') ? '' : eol)
            : `${eol}${eol}`;
        const appended = `${existingToml}${sep}${suffix}${eol}`;
        const verifiedAppended = parseTomlDocument(appended);
        const appendedServer = verifiedAppended.root.mcp_servers?.[serverName];
        if (
            !isPlainTable(appendedServer)
            || appendedServer.command !== stableServer.command
            || !sameStringArray(appendedServer.args, stableServer.args)
            || !sameEnvRecord(appendedServer.env, Object.fromEntries(staticEnvEntries))
        ) {
            throw invalidToml('post-append TOML verification failed for managed server block');
        }
        if (!isDeepStrictEqual(stripManagedFieldsForTreeComparison(doc.root, serverName), stripManagedFieldsForTreeComparison(verifiedAppended.root, serverName))) {
            throw invalidToml('post-append TOML verification detected unrelated AST change');
        }
        return appended;
    }

    if (!isPlainTable(existingServer) || doc.inlineTables.has(existingServer)) {
        throw invalidToml(`mcp_servers.${seg} must be a standard TOML table`);
    }
    if (existingServer.env !== undefined && !isPlainTable(existingServer.env)) {
        throw invalidToml(`mcp_servers.${seg}.env must be a TOML table`);
    }
    if (existingServer.tools !== undefined) {
        if (!isPlainTable(existingServer.tools) || doc.inlineTables.has(existingServer.tools)) {
            throw invalidToml(`mcp_servers.${seg}.tools must be a standard TOML table`);
        }
        for (const [toolKey, toolVal] of Object.entries(existingServer.tools)) {
            if (!isPlainTable(toolVal)) {
                throw invalidToml(`mcp_servers.${seg}.tools.${formatTomlSegment(toolKey)} must be a TOML table`);
            }
        }
    }

    assertCompatibleAssistantServerIdentity(existingServer, stableServer);

    const mergedEnv: Record<string, string> = {};
    if (isPlainTable(existingServer.env)) {
        for (const [k, v] of Object.entries(existingServer.env)) {
            if (k !== ASSISTANT_SESSION_ID_ENV) mergedEnv[k] = String(v);
        }
    }
    for (const [k, v] of staticEnvEntries) mergedEnv[k] = v;

    if (
        existingServer.command === stableServer.command
        && sameStringArray(existingServer.args, stableServer.args)
        && sameEnvRecord(existingServer.env, mergedEnv)
    ) {
        return existingToml;
    }

    const serverPath = ['mcp_servers', serverName];
    const cmdPath = [...serverPath, 'command'];
    const argsPath = [...serverPath, 'args'];
    const envPath = [...serverPath, 'env'];

    const edits: TextEdit[] = [];
    let foundCmd = false;
    let foundArgs = false;
    let inlineEnvAssignment: TomlAssignmentSpan | null = null;
    const envKeyAssignments = new Map<string, TomlAssignmentSpan>();

    for (const section of doc.sections) {
        for (const a of section.assignments) {
            if (pathsEqual(a.fullPath, cmdPath)) {
                foundCmd = true;
                if (a.value !== stableServer.command) {
                    edits.push({ start: a.valueStart, end: a.valueEnd, replacement: JSON.stringify(stableServer.command) });
                }
            } else if (pathsEqual(a.fullPath, argsPath)) {
                foundArgs = true;
                if (!sameStringArray(a.value, stableServer.args)) {
                    edits.push({ start: a.valueStart, end: a.valueEnd, replacement: JSON.stringify(stableServer.args) });
                }
            } else if (pathsEqual(a.fullPath, envPath)) {
                inlineEnvAssignment = a;
            } else if (a.fullPath.length === 4 && pathsEqual(a.fullPath.slice(0, 3), envPath)) {
                envKeyAssignments.set(a.fullPath[3], a);
            }
        }
    }

    if (!foundCmd || !foundArgs) {
        throw invalidToml(`mcp_servers.${seg} is missing direct command/args assignments`);
    }

    const mergedEnvEntries = Object.entries(mergedEnv);
    if (inlineEnvAssignment) {
        if (mergedEnvEntries.length === 0) {
            edits.push({ start: inlineEnvAssignment.lineStart, end: inlineEnvAssignment.lineEnd, replacement: '' });
        } else {
            const inlinePairs = mergedEnvEntries.map(([k, v]) => `${formatTomlSegment(k)} = ${JSON.stringify(v)}`).join(', ');
            edits.push({ start: inlineEnvAssignment.valueStart, end: inlineEnvAssignment.valueEnd, replacement: `{ ${inlinePairs} }` });
        }
    } else {
        const envSection = doc.sections.find((s) => !s.isArrayTable && pathsEqual(s.headerPath, envPath));
        const staleSessionSpan = envKeyAssignments.get(ASSISTANT_SESSION_ID_ENV);

        if (envSection && mergedEnvEntries.length === 0) {
            const sectionBody = existingToml.slice(envSection.headerLineEnd, envSection.sectionEnd);
            const hasComments = sectionBody.split(/\r?\n/).some((l) => l.trim().startsWith('#'));
            if (!hasComments) {
                edits.push({ start: envSection.headerLineStart, end: envSection.sectionEnd, replacement: '' });
            } else if (staleSessionSpan) {
                edits.push({ start: staleSessionSpan.lineStart, end: staleSessionSpan.lineEnd, replacement: '' });
            }
        } else {
            if (staleSessionSpan) {
                edits.push({ start: staleSessionSpan.lineStart, end: staleSessionSpan.lineEnd, replacement: '' });
            }
            const missingEnvLines: string[] = [];
            for (const [k, v] of mergedEnvEntries) {
                const span = envKeyAssignments.get(k);
                if (span) {
                    if (span.value !== v) edits.push({ start: span.valueStart, end: span.valueEnd, replacement: JSON.stringify(v) });
                } else {
                    missingEnvLines.push(`${formatTomlSegment(k)} = ${JSON.stringify(v)}${eol}`);
                }
            }
            if (missingEnvLines.length > 0) {
                if (envSection) {
                    const insertPos = envSection.sectionEnd;
                    const prefix = insertPos > 0 && existingToml[insertPos - 1] !== '\n' ? eol : '';
                    edits.push({ start: insertPos, end: insertPos, replacement: `${prefix}${missingEnvLines.join('')}` });
                } else {
                    const serverSection = doc.sections.find((s) => !s.isArrayTable && pathsEqual(s.headerPath, serverPath));
                    const insertPos = serverSection ? serverSection.sectionEnd : existingToml.length;
                    const prefix = insertPos > 0 && existingToml[insertPos - 1] !== '\n' ? `${eol}${eol}` : eol;
                    const block = `${prefix}[mcp_servers.${seg}.env]${eol}${missingEnvLines.join('')}`;
                    edits.push({ start: insertPos, end: insertPos, replacement: block });
                }
            }
        }
    }

    const updated = applyTextEdits(existingToml, edits);
    const verified = parseTomlDocument(updated);
    const verifiedServer = verified.root.mcp_servers?.[serverName];
    if (!isPlainTable(verifiedServer) || verifiedServer.command !== stableServer.command || !sameStringArray(verifiedServer.args, stableServer.args)) {
        throw invalidToml('post-merge TOML verification failed for command/args');
    }
    if (!sameEnvRecord(verifiedServer.env, mergedEnv)) {
        throw invalidToml('post-merge TOML verification failed for env');
    }
    if (!isDeepStrictEqual(stripManagedFieldsForTreeComparison(doc.root, serverName), stripManagedFieldsForTreeComparison(verified.root, serverName))) {
        throw invalidToml('post-merge TOML verification detected unintended change to unrelated AST nodes');
    }
    return updated;
}
