/**
 * Chat History Persistence — Persist completed chat messages to local disk
 * 
 * Design:
 * - ~/.adhdev/history/{agentType}/YYYY-MM-DD.jsonl
 * - JSONL format (one line = one message, append-friendly)
 * - Track only new messages (hash comparison with previous)
 * - Auto-rotation (delete files older than 30 days)
 * - Async/non-blocking (no impact on chat collection)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HISTORY_DIR = path.join(os.homedir(), '.adhdev', 'history');
const RETAIN_DAYS = 30;

interface HistoryMessage {
    ts: string;           // ISO timestamp
    receivedAt: number;   // epoch ms
    role: 'user' | 'assistant' | 'system';
    content: string;
    agent: string;        // e.g. 'antigravity', 'cursor', 'gemini-cli'
    instanceId?: string;  // IDE instance UUID (distinguishes windows of the same agent type)
    sessionTitle?: string;
}

export class ChatHistoryWriter {
/** Last seen message count per agent (deduplication) */
    private lastSeenCounts = new Map<string, number>();
/** Last seen message hash per agent (deduplication) */
    private lastSeenHashes = new Map<string, Set<string>>();
    private rotated = false;

 /**
 * Append new messages to history
 * 
 * @param agentType agent type (e.g. 'antigravity', 'cursor')
 * @param messages Message array received from readChat
 * @param sessionTitle Current session title
 * @param instanceId IDE instance UUID (distinguishes windows of the same agent)
 */
    appendNewMessages(
        agentType: string,
        messages: Array<{ role: string; content: string; receivedAt?: number }>,
        sessionTitle?: string,
        instanceId?: string,
    ): void {
        if (!messages || messages.length === 0) return;

        try {
 // dedup key: agentType + instanceId
            const dedupKey = instanceId ? `${agentType}:${instanceId}` : agentType;
            let seenHashes = this.lastSeenHashes.get(dedupKey);
            if (!seenHashes) {
                seenHashes = new Set<string>();
                this.lastSeenHashes.set(dedupKey, seenHashes);
            }

 // Filter new messages
            const newMessages: HistoryMessage[] = [];
            for (const msg of messages) {
                const hash = `${msg.role}:${(msg.content || '').slice(0, 50)}`;
                if (seenHashes.has(hash)) continue;
                seenHashes.add(hash);
                newMessages.push({
                    ts: new Date(msg.receivedAt || Date.now()).toISOString(),
                    receivedAt: msg.receivedAt || Date.now(),
                    role: msg.role as 'user' | 'assistant' | 'system',
                    content: msg.content || '',
                    agent: agentType,
                    instanceId,
                    sessionTitle,
                });
            }

            if (newMessages.length === 0) return;

 // Append to file — separate file if instanceId exists
            const dir = path.join(HISTORY_DIR, this.sanitize(agentType));
            fs.mkdirSync(dir, { recursive: true });

            const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            const filePrefix = instanceId ? `${this.sanitize(instanceId)}_` : '';
            const filePath = path.join(dir, `${filePrefix}${date}.jsonl`);
            const lines = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
            fs.appendFileSync(filePath, lines, 'utf-8');

 // Detect session switch — reset hash if message count decreases
            const prevCount = this.lastSeenCounts.get(dedupKey) || 0;
            if (messages.length < prevCount * 0.5 && prevCount > 3) {
                seenHashes.clear();
                for (const msg of messages) {
                    seenHashes.add(`${msg.role}:${(msg.content || '').slice(0, 50)}`);
                }
            }
            this.lastSeenCounts.set(dedupKey, messages.length);

 // Rotate only once on first call
            if (!this.rotated) {
                this.rotated = true;
                this.rotateOldFiles().catch(() => {});
            }
        } catch {
 // Ignore history save failures (must not affect main functionality)
        }
    }

/** Called when agent session is explicitly changed */
    onSessionChange(agentType: string): void {
        this.lastSeenHashes.delete(agentType);
        this.lastSeenCounts.delete(agentType);
    }

 /** Delete history files older than 30 days */
    private async rotateOldFiles(): Promise<void> {
        try {
            if (!fs.existsSync(HISTORY_DIR)) return;
            const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;

            const agentDirs = fs.readdirSync(HISTORY_DIR, { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const dir of agentDirs) {
                const dirPath = path.join(HISTORY_DIR, dir.name);
                const files = fs.readdirSync(dirPath)
                    .filter(f => f.endsWith('.jsonl') || f.endsWith('.terminal.log'));

                for (const file of files) {
                    const filePath = path.join(dirPath, file);
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < cutoff) {
                        fs.unlinkSync(filePath);
                    }
                }
            }
        } catch {
 // Ignore rotate failure
        }
    }

 /** Allow only filename-safe characters */
    private sanitize(name: string): string {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
}

/**
 * Read history (static — called from P2P commands)
 * 
 * Read JSONL files in reverse order, returning most recent messages first.
 * When instanceId is specified, reads only that instance file.
 * Offset/limit-based paging.
 */
export function readChatHistory(
    agentType: string,
    offset: number = 0,
    limit: number = 30,
    instanceId?: string,
): { messages: HistoryMessage[]; hasMore: boolean } {
    try {
        const sanitized = agentType.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dir = path.join(HISTORY_DIR, sanitized);
        if (!fs.existsSync(dir)) return { messages: [], hasMore: false };

 // JSONL file list — filter by instanceId prefix if specified
        const sanitizedInstance = instanceId?.replace(/[^a-zA-Z0-9_-]/g, '_');
        const files = fs.readdirSync(dir)
            .filter(f => {
                if (!f.endsWith('.jsonl')) return false;
                if (sanitizedInstance) {
                    // With instanceId: only that instance's files
                    return f.startsWith(`${sanitizedInstance}_`);
                }
                // Without instanceId: include ALL files (legacy + instanced)
                return true;
            })
            .sort()
            .reverse();

 // Read lines from all files (reverse order)
        const allMessages: HistoryMessage[] = [];
        const needed = offset + limit + 1; // hasMore check +1

        for (const file of files) {
            if (allMessages.length >= needed) break;
            const filePath = path.join(dir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean);
            
 // Parse in reverse order
            for (let i = lines.length - 1; i >= 0; i--) {
                if (allMessages.length >= needed) break;
                try {
                    allMessages.push(JSON.parse(lines[i]));
                } catch { /* skip invalid lines */ }
            }
        }

 // offset/limit apply
        const sliced = allMessages.slice(offset, offset + limit);
        const hasMore = allMessages.length > offset + limit;

 // Sort in chronological order (top→bottom = oldest→newest)
        sliced.reverse();

        return { messages: sliced, hasMore };
    } catch {
        return { messages: [], hasMore: false };
    }
}
