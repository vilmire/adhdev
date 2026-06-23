/**
 * RF-ROUTER LOW family — coordinator-prompt override/append file commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Both handlers
 * read/write only the on-disk ~/.adhdev/coordinator-prompts directory (no router
 * instance state) and return the same CommandRouterResult the inlined cases did.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const coordinatorPromptHandlers: Record<string, LowFamilyHandler> = {
    list_coordinator_prompts: async (_ctx: LowFamilyContext, _args: any) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
        const entries: Record<string, { override: string; append: string }> = {};
        try {
            if (fs.existsSync(dir)) {
                for (const name of fs.readdirSync(dir)) {
                    // Bucket files into <key>.{md|append.md}; ignore others
                    // so a stray README or .DS_Store doesn't show up.
                    const matchOverride = name.match(/^([a-zA-Z0-9_.-]+)\.md$/);
                    const matchAppend = name.match(/^([a-zA-Z0-9_.-]+)\.append\.md$/);
                    // append-pattern wins when both match (file is `.append.md`).
                    const m = matchAppend || matchOverride;
                    if (!m) continue;
                    const isAppend = !!matchAppend;
                    const key = m[1];
                    const full = path.join(dir, name);
                    let content = '';
                    try { content = fs.readFileSync(full, 'utf8'); } catch { /* skip */ }
                    if (!entries[key]) entries[key] = { override: '', append: '' };
                    if (isAppend) entries[key].append = content;
                    else entries[key].override = content;
                }
            }
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
        return { success: true, dir, entries };
    },

    write_coordinator_prompt: async (_ctx: LowFamilyContext, args: any) => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const os = await import('node:os');
        const key = typeof args?.key === 'string' ? args.key.trim() : '';
        const kind = args?.kind === 'append' ? 'append' : 'override';
        const content = typeof args?.content === 'string' ? args.content : '';
        // Whitelist key chars so a malicious caller can't write
        // ../../etc/passwd. Same charset readUserPromptFile accepts.
        if (!key || !/^[a-zA-Z0-9_.-]+$/.test(key)) {
            return { success: false, error: 'key must match [a-zA-Z0-9_.-]+' };
        }
        const dir = path.join(os.homedir(), '.adhdev', 'coordinator-prompts');
        const filename = kind === 'append' ? `${key}.append.md` : `${key}.md`;
        const full = path.join(dir, filename);
        try {
            fs.mkdirSync(dir, { recursive: true });
            if (content.trim()) {
                fs.writeFileSync(full, content, { encoding: 'utf8', mode: 0o600 });
            } else if (fs.existsSync(full)) {
                // Empty content = "reset to default" — delete the file
                // so the daemon's readUserPromptFile path falls through.
                fs.unlinkSync(full);
            }
            return { success: true, path: full, kind, key };
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
    },
};
