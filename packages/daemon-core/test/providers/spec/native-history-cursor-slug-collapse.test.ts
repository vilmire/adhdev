/**
 * CURSOR-SLUG-DASH-COLLAPSE — workspace_from_input slug matching.
 *
 * cursor-agent stores transcripts under a project slug that turns every
 * non-[A-Za-z0-9_-] char into '-' AND collapses consecutive dashes
 * (live-measured v2026.08.11: workspace
 *   /private/tmp/claude-501/-Users-…-adhdev--claude-worktrees-…/cursor-ws1
 * is stored as
 *   private-tmp-claude-501-Users-…-adhdev-claude-worktrees-…-cursor-ws1).
 *
 * The daemon's slug verification only computed the UNCOLLAPSED form, so any
 * workspace whose real path already contains '-' next to another
 * non-alphanumeric (git worktrees, tmp scratch dirs) never matched — the
 * native read failed closed and the chat silently degraded to the PTY parse
 * for exactly those workspaces, despite the transcript existing on disk
 * (chat_history returned source: "native-unavailable"). This is the
 * "native available but PTY shown" defect class.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceFromInputIfSlugMatches } from '../../../src/providers/spec/native-history-executor.js';

// Build a workspace path whose slug contains consecutive dashes pre-collapse.
// (mkdtemp under tmpdir so realpathSync works; the dashes come from the
// directory names themselves.)
function makeWorkspace(): { ws: string; cleanup: () => void } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-collapse-'));
    const ws = path.join(base, '-Users-style--double', 'cursor-ws1');
    fs.mkdirSync(ws, { recursive: true });
    return { ws, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function collapsedSlugOf(p: string): string {
    const real = fs.realpathSync(p);
    return real.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-{2,}/g, '-');
}

describe('workspaceFromInputIfSlugMatches — cursor dash-collapsed slugs', () => {
    it('matches a transcript stored under the dash-COLLAPSED slug (cursor v2026.08 layout)', () => {
        const { ws, cleanup } = makeWorkspace();
        try {
            const slug = collapsedSlugOf(ws);
            const sourcePath = path.join('/home/u/.cursor/projects', slug, 'agent-transcripts', 'abc', 'abc.jsonl');
            expect(workspaceFromInputIfSlugMatches(sourcePath, { workspace: ws } as any)).toBe(ws);
        } finally { cleanup(); }
    });

    it('still matches the uncollapsed legacy form', () => {
        const { ws, cleanup } = makeWorkspace();
        try {
            const real = fs.realpathSync(ws);
            const legacySlug = real.replace(/^\/+/, '').replace(/[^A-Za-z0-9_-]/g, '-');
            const sourcePath = path.join('/home/u/.cursor/projects', legacySlug, 'agent-transcripts', 'abc.jsonl');
            expect(workspaceFromInputIfSlugMatches(sourcePath, { workspace: ws } as any)).toBe(ws);
        } finally { cleanup(); }
    });

    it('matches a truncated+hashed collapsed slug', () => {
        const { ws, cleanup } = makeWorkspace();
        try {
            const slug = collapsedSlugOf(ws);
            const truncated = `${slug.slice(0, Math.max(10, slug.length - 8))}-05d8f9d`;
            const sourcePath = path.join('/home/u/.cursor/projects', truncated, 'agent-transcripts', 'abc', 'abc.jsonl');
            expect(workspaceFromInputIfSlugMatches(sourcePath, { workspace: ws } as any)).toBe(ws);
        } finally { cleanup(); }
    });

    it('fails closed for an unrelated workspace (no aliasing)', () => {
        const { ws, cleanup } = makeWorkspace();
        try {
            const sourcePath = '/home/u/.cursor/projects/some-entirely-other-project/agent-transcripts/abc/abc.jsonl';
            expect(workspaceFromInputIfSlugMatches(sourcePath, { workspace: ws } as any)).toBe(undefined);
        } finally { cleanup(); }
    });
});
