/**
 * RF-ROUTER LOW family — provider-dev / spec debug commands.
 *
 * Powers the dev console's spec editor: read/write a session's spec.json, validate
 * an in-progress spec, and preview condition/section resolution against a live
 * session's screen. Extracted verbatim from executeDaemonCommand; reads only
 * ctx.deps.sessionRegistry + ctx.deps.cliManager. resolveSpecPathInProviders (a
 * `this`-free module helper) is relocated here unchanged.
 */
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

function resolveSpecPathInProviders(
    specPath: string,
    fsm: typeof import('node:fs'),
    pathm: typeof import('node:path'),
    osm: typeof import('node:os'),
): { ok: true; path: string } | { ok: false; error: string } {
    let rootReal: string;
    try {
        rootReal = fsm.realpathSync(pathm.join(osm.homedir(), '.adhdev', 'providers'));
    } catch (e) {
        return { ok: false, error: `providers root unavailable: ${(e as Error).message}` };
    }
    const resolved = pathm.resolve(specPath);
    const base = pathm.basename(resolved);
    if (!/^[\w.-]+\.json$/.test(base)) {
        return { ok: false, error: 'refused: spec file must be a *.json basename' };
    }
    let parentReal: string;
    try {
        parentReal = fsm.realpathSync(pathm.dirname(resolved));
    } catch (e) {
        return { ok: false, error: `spec directory not found: ${(e as Error).message}` };
    }
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + pathm.sep)) {
        return { ok: false, error: 'refused: spec path must be under the providers root' };
    }
    const safe = pathm.join(parentReal, base);
    // Reject if the final file itself is a symlink pointing elsewhere.
    try {
        const st = fsm.lstatSync(safe);
        if (st.isSymbolicLink()) return { ok: false, error: 'refused: spec path is a symlink' };
    } catch { /* file may not exist yet (write case) — fine */ }
    return { ok: true, path: safe };
}

export const specProviderDevHandlers: Record<string, LowFamilyHandler> = {
    get_spec_debug: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        const target = ctx.deps.sessionRegistry.get(sessionId);
        if (!target) return { success: false, error: 'Session not found', sessionId };
        const adapterObj = ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter;
        const snapshot = adapterObj
            ? (typeof (adapterObj as any).getDebugSnapshot === 'function'
                ? (adapterObj as any).getDebugSnapshot()
                : typeof (adapterObj as any).getDebugState === 'function'
                    ? (adapterObj as any).getDebugState()
                    : null)
            : null;
        return {
            success: true,
            sessionId,
            providerType: target.providerType,
            isSpecProvider: snapshot !== null,
            snapshot,
        };
    },

    // ── Spec source read/write for the debug panel's live editor.
    //    Lets the dashboard load a session's spec.json, edit it, and save it back —
    //    the driver's fs.watch picks up the change and hot-reloads the FSM with no
    //    restart. Writes are confined to files under ~/.adhdev/providers.
    get_spec_source: async (ctx: LowFamilyContext, args: any) => {
        const fsm = await import('node:fs');
        const pathm = await import('node:path');
        const osm = await import('node:os');
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        let specPath = typeof args?.specPath === 'string' ? args.specPath : '';
        if (!specPath && sessionId) {
            const target = ctx.deps.sessionRegistry.get(sessionId);
            const adapterObj = target ? ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter : null;
            const snap = adapterObj && typeof (adapterObj as any).getDebugSnapshot === 'function' ? (adapterObj as any).getDebugSnapshot() : null;
            specPath = snap?.specPath ?? '';
        }
        if (!specPath) return { success: false, error: 'specPath or resolvable targetSessionId required' };
        // Confine reads to the providers tree, resolving symlinks so a crafted path
        // can't escape via a symlinked spec file.
        const safe = resolveSpecPathInProviders(specPath, fsm, pathm, osm);
        if (!safe.ok) return { success: false, error: safe.error, specPath };
        try {
            const content = fsm.readFileSync(safe.path, 'utf8');
            return { success: true, specPath: safe.path, content };
        } catch (e) {
            return { success: false, error: `read failed: ${(e as Error).message}`, specPath };
        }
    },

    write_spec_source: async (_ctx: LowFamilyContext, args: any) => {
        const fsm = await import('node:fs');
        const pathm = await import('node:path');
        const osm = await import('node:os');
        const specPath = typeof args?.specPath === 'string' ? args.specPath : '';
        const content = typeof args?.content === 'string' ? args.content : '';
        if (!specPath) return { success: false, error: 'specPath required' };
        if (!content) return { success: false, error: 'content required' };
        // Confine writes to the providers tree (symlink-safe — see helper).
        const safe = resolveSpecPathInProviders(specPath, fsm, pathm, osm);
        if (!safe.ok) return { success: false, error: safe.error };
        // Validate JSON + (if v4) FSM structure before writing so a bad edit can't
        // break the live session — return precise errors.
        let parsed: unknown;
        try { parsed = JSON.parse(content); }
        catch (e) { return { success: false, error: `invalid JSON: ${(e as Error).message}` }; }
        if ((parsed as any)?.$schema === 'adhdev:cli/spec@4') {
            const { validateFsmSpec } = await import('../../providers/spec/fsm-loader.js');
            const errs = validateFsmSpec(parsed);
            if (errs.length) return { success: false, error: 'spec invalid', validationErrors: errs };
        }
        try {
            fsm.writeFileSync(safe.path, content, 'utf8');
            return { success: true, specPath: safe.path };
        } catch (e) {
            return { success: false, error: `write failed: ${(e as Error).message}` };
        }
    },

    // ── Validate an in-progress spec (string or object) without writing. The form
    //    builder calls this on every change so Save can stay disabled while there
    //    are structural / reference / regex errors.
    validate_spec: async (_ctx: LowFamilyContext, args: any) => {
        let parsed: unknown = args?.spec;
        if (typeof args?.content === 'string') {
            try { parsed = JSON.parse(args.content); }
            catch (e) { return { success: true, valid: false, errors: [`invalid JSON: ${(e as Error).message}`] }; }
        }
        if (!parsed || typeof parsed !== 'object') {
            return { success: true, valid: false, errors: ['spec must be an object or content string'] };
        }
        const schema = (parsed as any).$schema;
        if (schema === 'adhdev:cli/spec@4') {
            const { validateFsmSpec } = await import('../../providers/spec/fsm-loader.js');
            const errors = validateFsmSpec(parsed);
            return { success: true, valid: errors.length === 0, errors };
        }
        // v1/v3 left to the legacy loader path; the builder is v4-only.
        return { success: true, valid: false, errors: [`unsupported $schema "${schema}" — form builder is v4-only`] };
    },

    // ── Evaluate a single condition against a live session's current screen —
    //    powers the editor's "does this match right now?" preview. Returns the
    //    recursive match tree.
    eval_condition_preview: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        if (!args?.condition || typeof args.condition !== 'object') return { success: false, error: 'condition required' };
        const target = ctx.deps.sessionRegistry.get(sessionId);
        if (!target) return { success: false, error: 'Session not found', sessionId };
        const adapterObj = ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter as any;
        const snap = adapterObj && typeof adapterObj.getDebugSnapshot === 'function' ? adapterObj.getDebugSnapshot() : null;
        if (!snap?.screen) return { success: false, error: 'no live screen for session' };
        // Reconstruct the sections map the spec would resolve. We pass the spec's
        // sections so section-scoped regexes resolve the same way they do at
        // runtime; fall back to the on-disk spec.
        let sectionsDef: Record<string, unknown> | undefined;
        try {
            const fsm2 = await import('node:fs');
            if (snap.specPath) {
                const raw = JSON.parse(fsm2.readFileSync(snap.specPath, 'utf8'));
                sectionsDef = raw?.sections;
            }
        } catch { /* fall back to whole-screen matching */ }
        const { evaluateConditionPreview } = await import('../../providers/spec/fsm-evaluator.js');
        try {
            const result = evaluateConditionPreview(
                args.condition,
                sectionsDef as any,
                snap.screen,
                snap.cursorPosition ?? undefined,
            );
            return { success: true, result, sections: snap.sections ?? null };
        } catch (e) {
            return { success: false, error: `eval failed: ${(e as Error).message}` };
        }
    },

    // ── Resolve a sections map against a live session's screen — the section
    //    editor's "test" button. Returns, for each section id, the line range + the
    //    text it captures. Accepts an in-progress sections map so it previews
    //    unsaved edits.
    resolve_section_preview: async (ctx: LowFamilyContext, args: any) => {
        const sessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim()
            : typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
        if (!sessionId) return { success: false, error: 'targetSessionId required' };
        if (!args?.sections || typeof args.sections !== 'object') return { success: false, error: 'sections map required' };
        const target = ctx.deps.sessionRegistry.get(sessionId);
        if (!target) return { success: false, error: 'Session not found', sessionId };
        const adapterObj = ctx.deps.cliManager.findAdapter(target.providerType, { instanceKey: sessionId })?.adapter as any;
        const snap = adapterObj && typeof adapterObj.getDebugSnapshot === 'function' ? adapterObj.getDebugSnapshot() : null;
        if (!snap?.screen) return { success: false, error: 'no live screen for session' };
        const { resolveSections } = await import('../../providers/spec/evaluator.js');
        try {
            const lines = String(snap.screen).split('\n').map((l: string) => l.endsWith('\r') ? l.slice(0, -1) : l);
            const resolved = resolveSections(args.sections as any, lines);
            return {
                success: true,
                screenLineCount: lines.length,
                sections: resolved.map(s => ({ id: s.id, fromLine: s.fromLine, toLine: s.toLine, text: s.text })),
            };
        } catch (e) {
            return { success: false, error: `resolve failed: ${(e as Error).message}` };
        }
    },
};
