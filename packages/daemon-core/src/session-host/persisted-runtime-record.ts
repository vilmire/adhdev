import { createReadStream } from 'node:fs';

/** Storage writes {record,snapshot,updatedAt}, in that order. Read only the
 * bounded metadata object; terminal scrollback can be many megabytes. Legacy
 * unwrapped records use the same reader. Unknown/oversized layouts fail closed. */
export async function readPersistedRuntimeRecord(file: string): Promise<Record<string, any>> {
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16 * 1024 });
    let text = '', cursor = 0, start = -1, depth = 0;
    let quoted = false, escaped = false;
    try {
        for await (const chunk of stream) {
            text += chunk;
            if (text.length > 1024 * 1024) throw new Error('runtime_metadata_too_large');
            if (start < 0) {
                const envelope = /^\s*\{\s*"record"\s*:\s*/.exec(text);
                start = envelope ? envelope[0].length : text.search(/\S/);
                if (start < 0) continue;
                if (text[start] !== '{') throw new Error('runtime_metadata_invalid');
                cursor = start;
            }
            for (; cursor < text.length; cursor++) {
                const c = text[cursor];
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (c === '\\') escaped = true;
                    else if (c === '"') quoted = false;
                } else if (c === '"') quoted = true;
                else if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') {
                    if (--depth === 0) return JSON.parse(text.slice(start, cursor + 1));
                }
            }
        }
        throw new Error('runtime_metadata_incomplete');
    } finally {
        stream.destroy();
    }
}
