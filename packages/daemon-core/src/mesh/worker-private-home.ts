// Worker-private HOME materialization: link / copy the owner's home imports into a
// per-worker home (junctions on win32, fail closed) and resolve the trust home.
// Split out of worker-mcp-isolation.ts (re-exported there).

import {
    symlinkSync,
    statSync,
    copyFileSync,
    mkdirSync,
    existsSync,
    rmSync,
    readFileSync,
    writeFileSync,
} from 'fs';
import * as path from 'path';
import { type WorkerPrivateHomeSpec, deriveCursorWorkspaceSlug, findWorkerPrivateHomeSpec } from './worker-home-specs.js';
import * as os from 'os';
import { shortHash } from '../system/hash.js';
import { LOG } from '../logging/logger.js';

export interface PreparedWorkerHome {
    /** Absolute path to the worker-private HOME. */
    home: string;
    /** Imports that were actually materialized. */
    imported: string[];
    /** Imports whose source did not exist (non-required ones only). */
    skipped: string[];
    /**
     * Non-required imports whose source EXISTED but could not be linked or
     * copied into the private HOME (e.g. a win32 directory link that failed
     * even as a junction). The HOME itself is still established — see
     * `materializeWorkerHomeLink` for why one failed import must not take the
     * whole isolation down with it. Each entry is `<relativePath> (<reason>)`.
     */
    failed: string[];
}

/**
 * How one `symlink`-mode import was materialized.
 *
 *  - `symlink`  — a real symlink (POSIX always; win32 files with developer
 *                 mode / SeCreateSymbolicLinkPrivilege).
 *  - `junction` — a win32 NTFS directory junction.
 *  - `copy`     — a win32 file copy (symlink privilege unavailable).
 */
export type WorkerHomeLinkKind = 'symlink' | 'junction' | 'copy';

/**
 * Link `source` (an absolute path under the real home) to `target` inside the
 * worker-private HOME, choosing the mechanism by platform AND by source kind.
 *
 * ★Why the kind of the source matters (release blocker, 2026-09-27).
 *
 * `symlinkSync(source, target)` with no type argument needs
 * SeCreateSymbolicLinkPrivilege on win32, which an unprivileged user without
 * developer mode does not hold — it throws EPERM for files AND directories.
 * The old fallback was `copyFileSync`, which works for a file but throws
 * EISDIR for a directory. That throw escaped `prepareWorkerPrivateHome`,
 * `resolveWorkerMcpIsolation` swallowed it and returned no `workerHome`, and
 * the worker launched against the REAL home — i.e. with the coordinator's MCP
 * servers (node_repl & co.) in view, the exact leak isolation exists to close.
 * Every provider that links a DIRECTORY through was exposed: codex
 * (`sessions`), antigravity (`brain`/`conversations`), grok (`.grok/sessions`,
 * `.grok/bin`), kimi (`credentials`/`oauth`/`sessions`).
 *
 * So, per platform:
 *
 *  - POSIX: plain `symlinkSync(source, target)` for both kinds, unchanged.
 *  - win32 directory: an NTFS **junction** first. Junctions need no privilege
 *    and are write-through like a directory symlink, which is what the
 *    transcript surfaces require (the daemon reads them from the real home).
 *    Their one constraint — an absolute, local target — holds because every
 *    source is joined from `os.homedir()`. If the junction fails anyway (e.g. a
 *    home on a network volume) a `'dir'` symlink is tried, which succeeds with
 *    developer mode. A directory is NEVER copied: a copy would sever the
 *    transcript write-through and silently hide the worker's output.
 *  - win32 file: a `'file'` symlink, falling back to a copy (the accepted
 *    refresh-staleness cost documented on the import specs). A hardlink was
 *    considered and rejected: CLIs rotate credentials by atomic rename, which
 *    orphans a hardlink exactly like a copy while adding a same-volume
 *    requirement a copy does not have.
 *
 * Throws when no mechanism worked; the caller decides whether that one import
 * is fatal (only `required` ones are).
 */
function materializeWorkerHomeLink(source: string, target: string): WorkerHomeLinkKind {
    if (process.platform !== 'win32') {
        symlinkSync(source, target);
        return 'symlink';
    }
    const absSource = path.resolve(source);
    if (statSync(absSource).isDirectory()) {
        try {
            symlinkSync(absSource, target, 'junction');
            return 'junction';
        } catch (junctionErr: any) {
            try {
                symlinkSync(absSource, target, 'dir');
                return 'symlink';
            } catch (dirErr: any) {
                throw new Error(
                    `directory link failed (junction: ${junctionErr?.code || junctionErr?.message || junctionErr};`
                    + ` dir symlink: ${dirErr?.code || dirErr?.message || dirErr})`,
                );
            }
        }
    }
    try {
        symlinkSync(absSource, target, 'file');
        return 'symlink';
    } catch {
        copyFileSync(absSource, target);
        return 'copy';
    }
}

/**
 * Materialize a worker-private HOME for a provider that roots its config in `~`.
 *
 * Keyed by (providerType, workspace, sessionKey) so two workers of the same
 * type on the same machine never share one — sharing would reintroduce exactly
 * the cross-worker inheritance this exists to remove.
 *
 * ★Auth files are symlinked with their source permissions left untouched. We
 * verify the source is 0600 and REFUSE to import a world/group-readable auth
 * file: silently widening the exposure of a credential while claiming to
 * "isolate" would be worse than not isolating at all.
 */
export function prepareWorkerPrivateHome(
    spec: WorkerPrivateHomeSpec,
    opts: { workspace: string; sessionKey: string; realHome?: string; baseDir?: string },
): PreparedWorkerHome {
    const realHome = opts.realHome || os.homedir();
    const baseDir = opts.baseDir || path.join(os.tmpdir(), 'adhdev-worker-home');
    const scope = shortHash(`${spec.providerType}${path.resolve(opts.workspace || '')}${opts.sessionKey}`);
    const home = path.join(baseDir, `${spec.providerType}-${scope}`);

    mkdirSync(home, { recursive: true });
    for (const dir of spec.ensureDirs || []) {
        mkdirSync(path.join(home, dir), { recursive: true });
    }

    const imported: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    // ★The real-home base for SOURCES is not always `realHome` itself. When the
    // private root stands in for `~/<prefix>` (codex, kimi), imports are
    // declared root-relative, so the source lives one segment deeper. Joining
    // both ends from the same string — as this loop did until 2026-09-19 —
    // makes every such source miss, and because these entries are deliberately
    // optional the miss is a SILENT skip that yields an empty root and a CLI
    // launched with no credentials. See `WorkerHomeImport.relativePath`.
    const importPrefix = String(spec.configRootPrefix || '').trim();
    const sourceBase = importPrefix ? path.join(realHome, importPrefix) : realHome;
    for (const entry of spec.imports) {
        const source = entry.sourceRelativePath
            ? path.join(realHome, entry.sourceRelativePath)
            : path.join(sourceBase, entry.relativePath);
        const target = path.join(home, entry.relativePath);
        const isRequired = typeof entry.required === 'function'
            ? entry.required(process.platform)
            : Boolean(entry.required);
        if (!existsSync(source)) {
            if (isRequired) {
                throw new Error(
                    `worker_private_home_missing_required_import: ${entry.relativePath} not found under ${sourceBase}`,
                );
            }
            // ★Antigravity's oauth-token entry is a per-platform predicate (see its
            // spec comment) precisely because darwin/win32 auth through the OS
            // keyring rather than this file — a skip here is the EXPECTED steady
            // state on those platforms, not a degraded one, so it gets its own INFO
            // line rather than folding silently into the generic `skipped` list.
            if (
                spec.providerType === 'antigravity-cli'
                && entry.relativePath === path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')
                && (process.platform === 'darwin' || process.platform === 'win32')
            ) {
                LOG.info(
                    'WorkerMcp',
                    `[antigravity-cli] oauth-token file absent on ${process.platform} — keyring auth expected, private HOME still isolates`,
                );
            }
            skipped.push(entry.relativePath);
            continue;
        }

        // Refuse to import a credential whose source permissions are already
        // loose. See the note above — isolation must not become a laundering
        // step for an over-permissive file. Only asserted for entries flagged
        // as credential material: shared data dirs (brain/, conversations/)
        // are legitimately 0755 and must not trip this.
        if (entry.requireOwnerOnly && process.platform !== 'win32') {
            const mode = statSync(source).mode & 0o777;
            if (mode & 0o077) {
                throw new Error(
                    `worker_private_home_insecure_source: ${entry.relativePath} is mode ${mode.toString(8)} (expected owner-only)`,
                );
            }
        }

        mkdirSync(path.dirname(target), { recursive: true });
        // Replace any stale entry from a previous launch that reused this key.
        try { rmSync(target, { force: true }); } catch { /* best effort */ }

        // ★Per-import failure policy (release blocker, 2026-09-27).
        //
        // A failure to materialize ONE import must not tear down the whole
        // private HOME: until this date a single win32 directory link (EISDIR
        // from the copy fallback) escaped this loop, the caller swallowed it,
        // and the worker ran against the REAL home with the coordinator's MCP
        // servers in view. The HOME is the isolation; an individual import is
        // only a convenience that keeps the worker authenticated or keeps its
        // transcripts visible. So:
        //
        //  - non-required import fails ⇒ WARN, record it in `failed`, continue.
        //    The worker stays isolated; at worst it is unauthenticated (a loud,
        //    visible failure) or its transcripts are not linked through.
        //  - `required` import fails ⇒ throw, exactly like a missing required
        //    source. The caller then refuses the launch (fail CLOSED) — see
        //    `resolveWorkerMcpIsolation` / `privateHomeError`.
        try {
            if (entry.mode === 'symlink') {
                const kind = materializeWorkerHomeLink(source, target);
                if (kind !== 'symlink') {
                    LOG.info('WorkerMcp', `[${spec.providerType}] ${entry.relativePath} imported as ${kind} (${process.platform})`);
                }
            } else if (entry.stripJsonKeys?.length) {
                const parsed = JSON.parse(readFileSync(source, 'utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
                for (const key of entry.stripJsonKeys) delete parsed[key];
                writeFileSync(target, JSON.stringify(parsed, null, 2), { mode: 0o600 });
            } else {
                copyFileSync(source, target);
            }
        } catch (err: any) {
            const reason = err?.code || err?.message || String(err);
            if (isRequired) {
                throw new Error(
                    `worker_private_home_import_failed: required ${entry.relativePath} could not be linked (${reason})`,
                );
            }
            LOG.warn(
                'WorkerMcp',
                `[${spec.providerType}] import ${entry.relativePath} failed (${reason}) — private HOME kept without it`,
            );
            failed.push(`${entry.relativePath} (${reason})`);
            continue;
        }
        imported.push(entry.relativePath);
    }

    // ─── Workspace-derived links ────────────────────────────────────────
    //
    // Resolved HERE rather than declared statically because the directory name
    // is a function of the workspace, which only this call knows. See
    // `WorkerWorkspaceLink` for why a static `relativePath` cannot express it.
    //
    // ★The real-side directory is CREATED when absent. A first-ever launch in a
    // workspace has no project directory yet, and the generic missing-import
    // skip contract would be wrong here: skipping leaves the worker writing
    // transcripts into its private HOME, where the daemon never looks — a
    // silent zero-message session rather than a visible failure. Creating the
    // real leaf is also what the CLI would have done on its own.
    for (const link of spec.workspaceLinks || []) {
        const slug = deriveCursorWorkspaceSlug(opts.workspace || '');
        if (!slug) continue;
        const rel = path.join(link.projectsDir, slug, link.relativePath);
        const source = path.join(realHome, rel);
        const target = path.join(home, rel);
        try {
            mkdirSync(source, { recursive: true });
            mkdirSync(path.dirname(target), { recursive: true });
            try { rmSync(target, { force: true, recursive: true }); } catch { /* best effort */ }
            // Same win32 junction rule as the static imports — the source is
            // always a directory, so an unprivileged win32 host gets a junction
            // instead of the EPERM a bare symlink would raise.
            materializeWorkerHomeLink(source, target);
            imported.push(rel);
        } catch (err: any) {
            // Never fatal. A worker that writes transcripts somewhere the daemon
            // cannot read is degraded, but a worker that fails to LAUNCH over a
            // transcript link is an outage. (On win32 the junction above needs
            // no privilege, so this is now reached only when even that fails.)
            LOG.warn('WorkerMcp', `workspace link ${rel} unavailable: ${err?.message || err}`);
            skipped.push(rel);
        }
    }

    return { home, imported, skipped, failed };
}

export interface WorkerTrustHome {
    /** Absolute worker-scoped HOME the trust store is resolved against. */
    home: string;
    imported: string[];
    skipped: string[];
}

/**
 * ★Resolve the worker-scoped HOME used by the TRUST axis, independent of
 * `ADHDEV_WORKER_MCP`.
 *
 * ─── Why this exists separately from resolveWorkerMcpIsolation() ─────────
 *
 * `pre_launch_trust` and worker-MCP isolation share one mechanism (a
 * worker-private HOME) but answer to different requirements, and coupling them
 * produced a live hang:
 *
 *   ADHDEV_WORKER_MCP was OFF by default ⇒ resolveWorkerMcpIsolation() returns
 *   null ⇒ the delegated launch had no `workerHome` ⇒ no trust plan was built
 *   ⇒ fsm-driver's fail-closed branch skipped the pre-trust write ⇒ every
 *   antigravity worker sat forever on "Do you trust the files in this folder?".
 *
 * The MCP axis is a HARDENING feature: with it off the worker keeps the
 * (weaker) isolation it always had, which is a degradation, not a stall. The
 * trust axis is not like that — with it off the worker does not run at all. So
 * it must not inherit the MCP flag's state in either direction.
 *
 * ★The MCP flag now defaults ON (2026-09-18), so the exact hang above is no
 * longer reachable by default — but the decoupling stays, because
 * ADHDEV_WORKER_MCP=off is still a supported opt-out and re-coupling these two
 * axes would make that opt-out silently stall every antigravity worker again.
 * The flip narrows this bug's blast radius; it does not remove the reason for
 * the split.
 *
 * ─── Why this cannot just resolve `~` to the daemon's HOME ───────────────
 *
 * That is the worker trust leak the fail-closed guard was written for: the
 * worktree path would be appended to the OWNER's personal `trustedWorkspaces`
 * array, silently granting every future interactive `agy` run in that
 * directory a trust the owner never approved. This function therefore always
 * returns a worker-scoped directory under the worker-home base dir, never the
 * real home — and the caller exports it as HOME so the CLI actually reads the
 * projected store rather than the owner's.
 *
 * Reuses WORKER_PRIVATE_HOME_SPECS wholesale, which is what keeps the
 * redirection safe: auth material and transcript directories are symlinked
 * THROUGH to the real home (so the worker stays logged in and the daemon's
 * os.homedir()-rooted transcript reader still finds what the worker writes),
 * while `settings.json` — the trust store itself — is COPIED, so the trust
 * projection has no write-through path back to the user's file.
 *
 * Returns null for a provider with no private-HOME spec (there is nothing to
 * isolate), and null on preparation failure — the caller must then fail closed
 * exactly as before rather than fall back to the real home.
 */
export function resolveWorkerTrustHome(input: {
    providerType: string;
    workspace: string;
    sessionKey: string;
    realHome?: string;
    baseDir?: string;
}): WorkerTrustHome | null {
    const spec = findWorkerPrivateHomeSpec(input.providerType);
    if (!spec) return null;
    try {
        const prepared = prepareWorkerPrivateHome(spec, {
            workspace: input.workspace,
            sessionKey: input.sessionKey,
            realHome: input.realHome,
            baseDir: input.baseDir,
        });
        return { home: prepared.home, imported: prepared.imported, skipped: prepared.skipped };
    } catch (err: any) {
        // Never downgrade to the real home — see the leak note above.
        LOG.warn('WorkerTrust', `worker trust HOME preparation failed for ${input.providerType}: ${err?.message || err}`);
        return null;
    }
}
