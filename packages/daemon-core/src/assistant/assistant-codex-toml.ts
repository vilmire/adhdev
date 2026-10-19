/**
 * TOML 1.0 parser, semantic validator, server-identity guard, and AST-span
 * surgical updater for `<workspace>/.codex/config.toml`.
 *
 * Why this exists:
 * - Codex CLI (`codex-rs/core/src/mcp_tool_call.rs`) only persists owner-selected
 *   "Always allow" (`ReviewDecision::ApprovedMcpPolicyAmendment`) when
 *   `mcp_servers.<server>` is present as a valid `McpServerConfig` in
 *   `ConfigLayerSource::Project` (`.codex/config.toml`) or user config.
 * - Line-regex slicing corrupts multiline arrays/strings, drops custom `env`
 *   keys, misses quoted headers/keys, and fails to detect malformed TOML or
 *   foreign server definitions that happen to share the name `adhdev-assistant`.
 * - This module parses the full TOML 1.0 grammar used by Codex configs,
 *   records exact source spans for every table and key-value assignment,
 *   verifies that any existing `adhdev-assistant` entry belongs to the same
 *   managed ADHDev assistant MCP server identity before preserving `tools.*`
 *   consent, and leaves the file byte-for-byte untouched (`next === before`)
 *   on ordinary relaunches where the stable server definition already matches.
 */

import { basename, resolve } from 'node:path';
import { ASSISTANT_SESSION_ID_ENV } from '@adhdev/mesh-shared';

export interface AssistantCodexMcpServerSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
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
    arrayOfTables: Set<string>;
}

const UNSAFE_ENV_OVERRIDE_KEYS = new Set([
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'ADHDEV_COORDINATOR_MCP_ENTRY_PATH',
    'ADHDEV_COORDINATOR_MCP_COMMAND',
    'ADHDEV_COORDINATOR_MCP_PORT',
    'ADHDEV_COORDINATOR_MCP_TRANSPORT',
]);

const NON_STDIO_MCP_KEYS = new Set([
    'url',
    'bearer_token_env_var',
    'http_headers',
    'env_http_headers',
]);

function isPlainTable(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createTable(): Record<string, any> {
    return Object.create(null) as Record<string, any>;
}

function canonicalPathKey(path: readonly string[]): string {
    return JSON.stringify(path);
}

export function formatTomlSegment(segment: string): string {
    return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

/** Return a copy of `server` with the per-session `ADHDEV_ASSISTANT_SESSION_ID` key removed from `env`. */
export function withoutAssistantSessionEnv<T extends AssistantCodexMcpServerSpec>(server: T): T {
    if (!server.env) return { command: server.command, args: [...server.args] } as T;
    const nextEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(server.env)) {
        if (k === ASSISTANT_SESSION_ID_ENV) continue;
        nextEnv[k] = v;
    }
    if (Object.keys(nextEnv).length === 0) {
        return { command: server.command, args: [...server.args] } as T;
    }
    return { command: server.command, args: [...server.args], env: nextEnv } as T;
}

function invalidToml(message: string): Error {
    return new Error(`assistant_codex_config_invalid_toml: ${message}`);
}

function foreignServerError(message: string): Error {
    return new Error(`assistant_codex_config_foreign_server: ${message}`);
}

/**
 * Full TOML 1.0 recursive-descent parser with exact character span tracking.
 * Rejects syntax errors, unclosed strings/arrays/inline tables, duplicate keys,
 * duplicate table headers, and table/scalar/inline-table type conflicts.
 */
export function parseTomlDocument(source: string): ParsedTomlDocument {
    if (source.includes('\0')) {
        throw invalidToml('null byte in TOML input');
    }

    const len = source.length;
    let pos = 0;

    const root = createTable();
    const inlineTables = new WeakSet<object>();
    const explicitTables = new Set<string>();
    const dottedDefinedTables = new Map<string, string>(); // tablePathKey -> definingSectionKey
    const scalarOrArrayPaths = new Set<string>();
    const arrayOfTables = new Set<string>();

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
    let currentTableTarget: Record<string, any> = root;

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
            if (pos >= len || source[pos] !== '\n') {
                throw invalidToml(`bare CR without LF after ${context}`);
            }
            pos++;
            return;
        }
        if (source[pos] === '\n') {
            pos++;
            return;
        }
        throw invalidToml(`unexpected token ${JSON.stringify(source[pos])} after ${context}`);
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
                        if (source[pos] === '\r' && source[pos + 1] !== '\n') {
                            throw invalidToml('bare CR in multiline string');
                        }
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
                    while (pos + quoteCount < len && source[pos + quoteCount] === '"' && quoteCount < 5) {
                        quoteCount++;
                    }
                    if (quoteCount >= 6) throw invalidToml('too many consecutive quotes in multiline basic string');
                    const extra = quoteCount - 3;
                    out += '"'.repeat(extra);
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
                    while (pos + quoteCount < len && source[pos + quoteCount] === "'" && quoteCount < 5) {
                        quoteCount++;
                    }
                    if (quoteCount >= 6) throw invalidToml('too many consecutive single quotes in multiline literal string');
                    const extra = quoteCount - 3;
                    out += "'".repeat(extra);
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
        while (pos < len && /[A-Za-z0-9_-]/.test(source[pos])) {
            pos++;
        }
        if (pos === start) {
            throw invalidToml(`expected key segment at offset ${pos}`);
        }
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
            if (isHws(source[pos])) {
                pos++;
            } else if (source[pos] === '\r') {
                pos++;
                if (pos >= len || source[pos] !== '\n') throw invalidToml('bare CR inside array');
                pos++;
            } else if (source[pos] === '\n') {
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
                const elem = parseValue();
                arr.push(elem);
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
            const localDefined = new Set<string>();
            skipHws();
            if (pos < len && source[pos] === '}') {
                pos++;
                return tbl;
            }
            while (pos < len) {
                const kPath = parseKeyPath();
                skipHws();
                if (pos >= len || source[pos] !== '=') {
                    throw invalidToml(`expected '=' in inline table at offset ${pos}`);
                }
                pos++;
                const val = parseValue();
                let cursor: Record<string, any> = tbl;
                for (let i = 0; i < kPath.length - 1; i++) {
                    const seg = kPath[i];
                    const subKey = canonicalPathKey(kPath.slice(0, i + 1));
                    if (localDefined.has(subKey)) {
                        throw invalidToml(`conflicting key ${kPath.slice(0, i + 1).join('.')} in inline table`);
                    }
                    if (!(seg in cursor)) {
                        const sub = createTable();
                        inlineTables.add(sub);
                        cursor[seg] = sub;
                    } else if (!isPlainTable(cursor[seg])) {
                        throw invalidToml(`conflicting non-table key ${seg} in inline table`);
                    }
                    cursor = cursor[seg];
                }
                const leaf = kPath[kPath.length - 1];
                const fullKey = canonicalPathKey(kPath);
                if (leaf in cursor || localDefined.has(fullKey)) {
                    throw invalidToml(`duplicate key ${kPath.join('.')} in inline table`);
                }
                localDefined.add(fullKey);
                cursor[leaf] = val;
                skipHws();
                if (pos < len && source[pos] === ',') {
                    pos++;
                    skipHws();
                    if (pos < len && source[pos] === '}') {
                        throw invalidToml('trailing comma not permitted in TOML 1.0 inline table');
                    }
                    continue;
                }
                if (pos < len && source[pos] === '}') {
                    pos++;
                    return tbl;
                }
                throw invalidToml(`expected ',' or '}' in inline table at offset ${pos}`);
            }
            throw invalidToml('unterminated inline table');
        }

        // Scalar token: boolean, integer, float, or datetime
        const start = pos;
        while (pos < len && !isHws(source[pos]) && !isNewline(source[pos]) && source[pos] !== '#' && source[pos] !== ',' && source[pos] !== ']' && source[pos] !== '}') {
            pos++;
        }
        let rawToken = source.slice(start, pos);
        // Handle space-separated ISO date + time (e.g. 1979-05-27 07:32:00Z)
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
        if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(rawToken)) {
            return Number(rawToken.replace(/_/g, ''));
        }
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
        if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(rawToken)
            || /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawToken)) {
            return rawToken;
        }
        throw invalidToml(`invalid scalar value ${JSON.stringify(rawToken)}`);
    };

    const resolveHeaderTable = (headerPath: string[], isArrayTable: boolean): Record<string, any> => {
        const fullKey = canonicalPathKey(headerPath);
        if (!isArrayTable) {
            if (explicitTables.has(fullKey) || dottedDefinedTables.has(fullKey) || arrayOfTables.has(fullKey) || scalarOrArrayPaths.has(fullKey)) {
                throw invalidToml(`duplicate or conflicting table header [${headerPath.join('.')}]`);
            }
        } else {
            if (explicitTables.has(fullKey) || dottedDefinedTables.has(fullKey) || scalarOrArrayPaths.has(fullKey)) {
                throw invalidToml(`conflicting array-of-tables header [[${headerPath.join('.')}]]`);
            }
        }

        let cursor: Record<string, any> = root;
        for (let i = 0; i < headerPath.length - 1; i++) {
            const seg = headerPath[i];
            const prefixKey = canonicalPathKey(headerPath.slice(0, i + 1));
            if (scalarOrArrayPaths.has(prefixKey)) {
                throw invalidToml(`cannot open table [${headerPath.join('.')}]: ${headerPath.slice(0, i + 1).join('.')} is not a table`);
            }
            if (!(seg in cursor)) {
                cursor[seg] = createTable();
            } else if (Array.isArray(cursor[seg])) {
                if (!arrayOfTables.has(prefixKey) || cursor[seg].length === 0) {
                    throw invalidToml(`cannot traverse static array ${headerPath.slice(0, i + 1).join('.')}`);
                }
                cursor = cursor[seg][cursor[seg].length - 1];
                continue;
            } else if (!isPlainTable(cursor[seg]) || inlineTables.has(cursor[seg])) {
                throw invalidToml(`cannot extend inline or non-table ${headerPath.slice(0, i + 1).join('.')}`);
            }
            cursor = cursor[seg];
        }

        const leaf = headerPath[headerPath.length - 1];
        if (isArrayTable) {
            arrayOfTables.add(fullKey);
            if (!(leaf in cursor)) {
                cursor[leaf] = [];
            } else if (!Array.isArray(cursor[leaf])) {
                throw invalidToml(`conflicting non-array value at [[${headerPath.join('.')}]]`);
            }
            const elem = createTable();
            cursor[leaf].push(elem);
            return elem;
        }

        explicitTables.add(fullKey);
        if (!(leaf in cursor)) {
            cursor[leaf] = createTable();
        } else if (!isPlainTable(cursor[leaf]) || inlineTables.has(cursor[leaf])) {
            throw invalidToml(`conflicting value at [${headerPath.join('.')}]`);
        }
        return cursor[leaf];
    };

    const assignIntoSection = (sectionPath: string[], targetObj: Record<string, any>, keyPath: string[], value: unknown) => {
        const sectionKey = canonicalPathKey(sectionPath);
        let cursor = targetObj;
        for (let i = 0; i < keyPath.length - 1; i++) {
            const seg = keyPath[i];
            const subPath = [...sectionPath, ...keyPath.slice(0, i + 1)];
            const subKey = canonicalPathKey(subPath);
            if (scalarOrArrayPaths.has(subKey) || arrayOfTables.has(subKey)) {
                throw invalidToml(`conflicting key path ${subPath.join('.')}`);
            }
            if (explicitTables.has(subKey)) {
                throw invalidToml(`cannot add dotted key to already-defined table [${subPath.join('.')}]`);
            }
            const prevOwner = dottedDefinedTables.get(subKey);
            if (prevOwner !== undefined && prevOwner !== sectionKey) {
                throw invalidToml(`cannot reopen dotted table ${subPath.join('.')} from another section`);
            }
            dottedDefinedTables.set(subKey, sectionKey);
            if (!(seg in cursor)) {
                cursor[seg] = createTable();
            } else if (!isPlainTable(cursor[seg]) || inlineTables.has(cursor[seg])) {
                throw invalidToml(`cannot extend inline or non-table key ${subPath.join('.')}`);
            }
            cursor = cursor[seg];
        }

        const leaf = keyPath[keyPath.length - 1];
        const fullPath = [...sectionPath, ...keyPath];
        const fullKey = canonicalPathKey(fullPath);
        if (leaf in cursor || explicitTables.has(fullKey) || dottedDefinedTables.has(fullKey) || arrayOfTables.has(fullKey) || scalarOrArrayPaths.has(fullKey)) {
            throw invalidToml(`duplicate or conflicting key ${fullPath.join('.')}`);
        }
        if (isPlainTable(value)) {
            // Inline table: mark all nested paths as sealed
            const markInline = (obj: Record<string, any>, prefix: string[]) => {
                const pk = canonicalPathKey(prefix);
                explicitTables.add(pk);
                for (const [k, v] of Object.entries(obj)) {
                    const childPath = [...prefix, k];
                    if (isPlainTable(v)) markInline(v, childPath);
                    else scalarOrArrayPaths.add(canonicalPathKey(childPath));
                }
            };
            markInline(value, fullPath);
        } else {
            scalarOrArrayPaths.add(fullKey);
        }
        cursor[leaf] = value;
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
            const isArrayTable = source.startsWith('[[', pos);
            pos += isArrayTable ? 2 : 1;
            skipHws();
            if (pos < len && source[pos] === ']') {
                throw invalidToml('empty table header []');
            }
            const headerPath = parseKeyPath();
            skipHws();
            if (isArrayTable) {
                if (!source.startsWith(']]', pos)) {
                    throw invalidToml('expected closing ]] for array-of-tables header');
                }
                pos += 2;
            } else {
                if (pos >= len || source[pos] !== ']') {
                    throw invalidToml('expected closing ] for table header');
                }
                pos += 1;
            }
            consumeLineEndingOrEof('table header');
            const headerLineEnd = pos;
            currentTableTarget = resolveHeaderTable(headerPath, isArrayTable);
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

        // Key-value assignment
        const keyPath = parseKeyPath();
        skipHws();
        if (pos >= len || source[pos] !== '=') {
            throw invalidToml(`expected '=' after key ${keyPath.join('.')}`);
        }
        pos++; // consume =
        skipHws();
        const valueStart = pos;
        const value = parseValue();
        const valueEnd = pos;
        consumeLineEndingOrEof(`assignment to ${keyPath.join('.')}`);
        const lineEnd = pos;

        assignIntoSection(currentSection.headerPath, currentTableTarget, keyPath, value);
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
    commandIdentity: string;
    mode: 'ipc' | 'local';
    port: number | null;
    daemonUrl: string | null;
}

function normalizeIdentityPath(p: string): string {
    const normalized = p.trim().replace(/\\/g, '/');
    if (normalized.includes('/vendor/mcp-server/index.js')) {
        return normalized.includes('adhdev-preview') ? 'vendor:adhdev-preview:mcp-server/index.js' : 'vendor:adhdev:mcp-server/index.js';
    }
    return resolve(p.trim());
}

/**
 * Inspect a parsed `mcp_servers.<name>` table and extract its canonical ADHDev
 * assistant MCP server identity. Rejects foreign commands, non-stdio servers,
 * worker/mesh toolsets, missing `--assistant` or `--mode` flags, unknown flags,
 * or orphan `tools.*` tables that lack a server command/args anchor.
 */
export function parseManagedAssistantServerIdentity(
    entry: Record<string, any>,
): { ok: true; value: ManagedAssistantServerIdentity } | { ok: false; reason: string } {
    for (const key of Object.keys(entry)) {
        if (NON_STDIO_MCP_KEYS.has(key)) {
            return { ok: false, reason: `non-stdio MCP transport key "${key}" is not a managed assistant server` };
        }
    }
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
        return { ok: false, reason: 'missing or non-string MCP server command (orphan or non-stdio entry)' };
    }
    if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) {
        return { ok: false, reason: 'missing or non-string-array MCP server args' };
    }

    const command = entry.command.trim();
    const args: string[] = entry.args;
    const cmdBase = basename(command.replace(/\\/g, '/')).replace(/\.(?:exe|cmd|bat)$/i, '');

    let kind: ManagedAssistantServerIdentity['kind'];
    let track: ManagedAssistantServerIdentity['track'];
    let commandIdentity: string;
    let restArgs: string[];

    if ((cmdBase === 'adhdev' || cmdBase === 'adhdev-preview') && args[0] === 'mcp') {
        kind = 'adhdev-cli';
        track = cmdBase;
        commandIdentity = command.includes('/') || command.includes('\\') ? normalizeIdentityPath(command) : cmdBase;
        restArgs = args.slice(1);
    } else if (cmdBase.startsWith('adhdev-mcp') || command.includes('/vendor/mcp-server/') || command.includes('\\vendor\\mcp-server\\')) {
        kind = 'adhdev-mcp-bin';
        track = cmdBase.includes('preview') || command.includes('preview') ? 'adhdev-preview' : 'adhdev';
        commandIdentity = normalizeIdentityPath(command);
        restArgs = args;
    } else if (cmdBase === 'node' && args.length >= 1 && !args[0].startsWith('-')) {
        const script = args[0];
        if (!/(?:^|[\\/])(?:mcp-server|adhdev-mcp|fixture-mcp-server)/i.test(script)) {
            return { ok: false, reason: `unrecognized node entrypoint "${script}"` };
        }
        kind = 'node-entry';
        track = script.includes('adhdev-preview') ? 'adhdev-preview' : 'adhdev';
        commandIdentity = normalizeIdentityPath(script);
        restArgs = args.slice(1);
    } else {
        return { ok: false, reason: `unrecognized MCP server command "${command}"` };
    }

    let hasAssistant = false;
    let mode: 'ipc' | 'local' | null = null;
    let port: number | null = null;

    for (let i = 0; i < restArgs.length; i++) {
        const arg = restArgs[i];
        if (arg === '--assistant') {
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
            if (!val || !val.trim()) {
                return { ok: false, reason: 'missing value for --daemon-auth-file' };
            }
            continue;
        }
        return { ok: false, reason: `unrecognized or non-assistant MCP server argument "${arg}"` };
    }

    if (!hasAssistant || !mode) {
        return { ok: false, reason: 'MCP server args must include --assistant and --mode <ipc|local>' };
    }

    const env = isPlainTable(entry.env) ? entry.env : undefined;
    const daemonUrl = typeof env?.ADHDEV_DAEMON_URL === 'string' && env.ADHDEV_DAEMON_URL.trim()
        ? env.ADHDEV_DAEMON_URL.trim()
        : null;

    return {
        ok: true,
        value: {
            kind,
            track,
            commandIdentity,
            mode,
            port,
            daemonUrl,
        },
    };
}

/**
 * Verify that `existingEntry` in `.codex/config.toml` represents the SAME
 * managed ADHDev assistant server identity as `desiredServer`. Throws
 * `assistant_codex_config_foreign_server` if the command, entrypoint, track,
 * transport mode, daemon port, or daemon URL differs, or if unsafe env
 * overrides are present.
 */
export function assertCompatibleAssistantServerIdentity(
    existingEntry: Record<string, any>,
    desiredServer: AssistantCodexMcpServerSpec,
): void {
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
    if (a.kind !== b.kind || a.track !== b.track || a.commandIdentity !== b.commandIdentity) {
        throw foreignServerError(
            `existing server command/entrypoint (${a.kind}:${a.commandIdentity}) does not match target (${b.kind}:${b.commandIdentity})`,
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
            if (typeof v !== 'string') {
                throw invalidToml(`mcp_servers env key "${k}" must be a string`);
            }
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
    if ( existingEnv === undefined ) return desiredKeys.length === 0;
    if (!isPlainTable(existingEnv)) return false;
    const existingKeys = Object.keys(existingEnv);
    if (existingKeys.length !== desiredKeys.length) return false;
    return desiredKeys.every((k) => existingEnv[k] === desiredEnv[k]);
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

function serializeServerBlock(seg: string, server: AssistantCodexMcpServerSpec, envEntries: Array<[string, string]>): string {
    const lines = [
        `[mcp_servers.${seg}]`,
        `command = ${JSON.stringify(server.command)}`,
        `args = ${JSON.stringify(server.args)}`,
    ];
    if (envEntries.length > 0) {
        lines.push('', `[mcp_servers.${seg}.env]`);
        for (const [k, v] of envEntries) {
            lines.push(`${formatTomlSegment(k)} = ${JSON.stringify(v)}`);
        }
    }
    return lines.join('\n');
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
        if (edit.end > prevStart) {
            throw invalidToml('overlapping AST edits while updating TOML');
        }
        out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
        prevStart = edit.start;
    }
    return out;
}

/**
 * Validate and merge `[mcp_servers.<serverName>]` into `<workspace>/.codex/config.toml`:
 * - Rejects malformed or structurally conflicting TOML before any change.
 * - Rejects foreign/incompatible `mcp_servers.<serverName>` entries (or orphan
 *   `tools.*` tables without a recognized managed server definition) so consent
 *   is never transferred across unrelated servers or silently erased.
 * - Keeps per-session `ADHDEV_ASSISTANT_SESSION_ID` out of the persisted file
 *   (it is passed via `-c` CLI overrides), returning `existingToml` byte-for-byte
 *   unchanged on ordinary relaunches when the stable server definition already matches.
 * - Preserves multiline `args` (updating the full array span when changed),
 *   quoted keys/headers, custom user `env` keys, extra server settings,
 *   Codex-persisted `[mcp_servers.<serverName>.tools.*]` policies, unrelated
 *   tables, and comments.
 */
export function mergeAssistantCodexMcpConfigToml(
    existingToml: string,
    serverName: string,
    server: AssistantCodexMcpServerSpec,
): string {
    const stableServer = withoutAssistantSessionEnv(server);
    // Validate that the target server itself is a recognized managed assistant server.
    const targetIdentity = parseManagedAssistantServerIdentity(stableServer);
    if (!targetIdentity.ok) {
        throw foreignServerError(`refusing to write unrecognized assistant MCP server config (${targetIdentity.reason})`);
    }

    const seg = formatTomlSegment(serverName);
    const staticEnvEntries = Object.entries(stableServer.env ?? {}).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));

    if (!existingToml.trim()) {
        const fresh = `${serializeServerBlock(seg, stableServer, staticEnvEntries)}\n`;
        parseTomlDocument(fresh);
        return fresh;
    }

    const doc = parseTomlDocument(existingToml);
    const mcpServers = doc.root.mcp_servers;
    if (mcpServers !== undefined) {
        if (!isPlainTable(mcpServers) || doc.inlineTables.has(mcpServers) || doc.arrayOfTables.has(canonicalPathKey(['mcp_servers']))) {
            throw invalidToml('mcp_servers must be a standard TOML table');
        }
    }

    const existingServer = mcpServers?.[serverName];
    if (existingServer === undefined) {
        const suffix = serializeServerBlock(seg, stableServer, staticEnvEntries);
        const trimmedEnd = existingToml.replace(/\s+$/, '');
        const appended = `${trimmedEnd}\n\n${suffix}\n`;
        parseTomlDocument(appended);
        return appended;
    }

    if (!isPlainTable(existingServer) || doc.inlineTables.has(existingServer) || doc.arrayOfTables.has(canonicalPathKey(['mcp_servers', serverName]))) {
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

    // P2 Identity check: verify existing entry is the SAME managed ADHDev assistant server.
    assertCompatibleAssistantServerIdentity(existingServer, stableServer);

    // Compute desired merged env: preserve custom user env keys (excluding session ID), overlay static server env.
    const mergedEnv: Record<string, string> = {};
    if (isPlainTable(existingServer.env)) {
        for (const [k, v] of Object.entries(existingServer.env)) {
            if (k === ASSISTANT_SESSION_ID_ENV) continue;
            mergedEnv[k] = String(v);
        }
    }
    for (const [k, v] of staticEnvEntries) {
        mergedEnv[k] = v;
    }

    // Fast path: if existing TOML already has the exact desired command, args, and env (and no stale session ID),
    // return existingToml completely untouched so ordinary relaunches perform zero disk writes.
    if (
        existingServer.command === stableServer.command
        && sameStringArray(existingServer.args, stableServer.args)
        && sameEnvRecord(existingServer.env, mergedEnv)
    ) {
        return existingToml;
    }

    // Surgical AST-span update for command, args, and env.
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

        // Check if the entire [mcp_servers.<serverName>.env] section becomes empty and has no comments
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
                    if (span.value !== v) {
                        edits.push({ start: span.valueStart, end: span.valueEnd, replacement: JSON.stringify(v) });
                    }
                } else {
                    missingEnvLines.push(`${formatTomlSegment(k)} = ${JSON.stringify(v)}\n`);
                }
            }
            if (missingEnvLines.length > 0) {
                if (envSection) {
                    const insertPos = envSection.sectionEnd;
                    const prefix = insertPos > 0 && existingToml[insertPos - 1] !== '\n' ? '\n' : '';
                    edits.push({ start: insertPos, end: insertPos, replacement: `${prefix}${missingEnvLines.join('')}` });
                } else {
                    const serverSection = doc.sections.find((s) => !s.isArrayTable && pathsEqual(s.headerPath, serverPath));
                    const insertPos = serverSection ? serverSection.sectionEnd : existingToml.length;
                    const prefix = insertPos > 0 && existingToml[insertPos - 1] !== '\n' ? '\n\n' : '\n';
                    const block = `${prefix}[mcp_servers.${seg}.env]\n${missingEnvLines.join('')}`;
                    edits.push({ start: insertPos, end: insertPos, replacement: block });
                }
            }
        }
    }

    const updated = `${applyTextEdits(existingToml, edits).replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    const verified = parseTomlDocument(updated);
    const verifiedServer = verified.root.mcp_servers?.[serverName];
    if (!isPlainTable(verifiedServer) || verifiedServer.command !== stableServer.command || !sameStringArray(verifiedServer.args, stableServer.args)) {
        throw invalidToml('post-merge TOML verification failed for command/args');
    }
    if (!sameEnvRecord(verifiedServer.env, mergedEnv)) {
        throw invalidToml('post-merge TOML verification failed for env');
    }
    return updated;
}
