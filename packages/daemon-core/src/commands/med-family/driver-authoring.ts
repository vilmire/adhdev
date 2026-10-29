/**
 * Driver authoring commands (design docs/design/2026-10-29-driver-authoring-and-sharing.md).
 *
 * Worker verbs (`driver_scaffold|validate|export|install`) are credentialed like
 * `driver_invoke` and confined to the worker's registered session workspace.
 * `driver_import` is the owner dashboard verb (p2p/standalone only).
 *
 * None of these ever activates a driver: install lands INACTIVE bytes and the
 * resulting activation request is staged for the owner (assistant Inbox). They
 * never call DriverActivationStore.approve/setDisabled.
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineCommandSpecs } from '../command-registry.js';
import type { MedFamilyContext, MedFamilyHandler } from './types.js';
import { resolveWorkerIdentity } from '../../mesh/worker-report.js';
import { resolveRegisteredSessionWorkspace } from './artifact-sharing.js';
import { artifactHandlers } from './artifacts.js';
import { getDriverService } from './drivers.js';
import { LOG } from '../../logging/logger.js';
import { getConfigDir } from '../../config/config.js';
import { installDriverPackage } from '../../drivers/driver-install.js';
import {
    DRIVER_BUNDLE_MAX_JSON_BYTES, DriverPackageError, decodeDriverBundle, encodeDriverBundle, isValidDriverType,
    readDriverPackageDir, scaffoldDriverFiles, verifyDriverFiles, type ScaffoldInput, type VerifiedDriverPackage,
} from '../../drivers/driver-package.js';

const fail = (code: string, error: string) => ({ success: false as const, code, error });
const asFailure = (error: unknown) => error instanceof DriverPackageError ? fail(error.code, error.message)
    : fail('driver_authoring_failed', error instanceof Error ? error.message : String(error));

/**
 * Resolve `rel` inside `root` (already a realpath). Existing paths must realpath inside;
 * for a not-yet-existing path the nearest existing ancestor must. No symlink may leave the root.
 */
export function resolveInsideWorkspace(root: string, rel: unknown): string {
    if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0') || isAbsolute(rel)) throw new DriverPackageError('invalid_path', 'A workspace-relative path is required');
    const full = resolve(root, rel);
    const lexical = relative(root, full);
    if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) throw new DriverPackageError('path_outside_workspace', 'Path escapes the workspace');
    let probe = full;
    for (;;) {
        try { lstatSync(probe); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = dirname(probe);
            if (parent === probe) throw new DriverPackageError('invalid_path', 'No existing ancestor');
            probe = parent;
        }
    }
    const real = relative(root, realpathSync(probe));
    if (real.startsWith('..') || isAbsolute(real)) throw new DriverPackageError('path_outside_workspace', 'Path resolves outside the workspace');
    return full;
}

async function workerWorkspace(ctx: MedFamilyContext, args: any): Promise<{ root: string } | { failure: ReturnType<typeof fail> }> {
    const identity = resolveWorkerIdentity({ token: args?.token, bind: args?.bind });
    if (!identity?.sessionId || !identity.meshId || !identity.taskId) return { failure: fail('worker_credential_required', 'A worker credential is required') };
    const ws = await resolveRegisteredSessionWorkspace(ctx, identity.sessionId, {
        meshId: identity.meshId, taskId: identity.taskId, ...(identity.nodeId ? { nodeId: identity.nodeId } : {}), allowTrustedWorkerFallback: true });
    if (!ws.workspaceRoot) return { failure: fail('workspace_unavailable', 'The worker session workspace could not be resolved') };
    try { return { root: realpathSync(ws.workspaceRoot) }; }
    catch { return { failure: fail('workspace_unavailable', 'The worker session workspace is not readable') }; }
}

function readBundleFile(path: string): string {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DriverPackageError('invalid_path', 'Bundle path must be a regular file');
    if (stat.size > DRIVER_BUNDLE_MAX_JSON_BYTES) throw new DriverPackageError('package_too_large', 'Bundle exceeds the 4 MiB limit');
    return readFileSync(path, 'utf8');
}

/** Fetch a registered bundle artifact through the EXISTING artifact_fetch authority (grants, origin fetch, limits). */
async function fetchBundleArtifact(ctx: MedFamilyContext, args: any): Promise<string> {
    const res: any = await artifactHandlers.artifact_fetch(ctx, args);
    if (!res?.success) throw new DriverPackageError(typeof res?.code === 'string' ? res.code : 'artifact_unavailable', typeof res?.error === 'string' ? res.error : 'Artifact could not be fetched');
    if (res.kind !== 'json' || res.encoding !== 'utf8' || typeof res.content !== 'string') throw new DriverPackageError('bundle_invalid', 'Artifact is not a driver bundle (json)');
    return res.content;
}

/** Common tail: install bytes, hot-load, stage the owner activation request. */
async function finishInstall(ctx: MedFamilyContext, pkg: VerifiedDriverPackage, origin: string) {
    const loader = ctx.deps.providerLoader as any;
    const type = pkg.report.type;
    const meta = loader.getMeta?.(type);
    const existing = meta ? { dir: (loader.findProviderDir?.(type) ?? null) as string | null } : null;
    const result = installDriverPackage(getConfigDir(), pkg, existing);
    loader.reload?.();
    const described: any = await getDriverService(ctx).describe(type);
    LOG.info('DriverAuthoring', `[driver-authoring] installed type=${type} digest=${pkg.report.treeDigest.slice(0, 19)} origin=${origin} replaced=${result.replaced} state=${described?.state}`);
    return { success: true, type, name: pkg.report.name, treeDigest: pkg.report.treeDigest, replaced: result.replaced,
        state: described?.state ?? 'installed', ...(described?.stagedId ? { stagedId: described.stagedId } : {}),
        riskClass: pkg.report.riskClass, reasons: pkg.report.reasons, declaredAccess: pkg.report.declaredAccess, runtime: pkg.report.runtime,
        approval: 'Not active yet: the owner must approve this driver activation (dashboard "needs you" / assistant Inbox).' };
}

export const driverAuthoringHandlers: Record<string, MedFamilyHandler> = {
    driver_scaffold: async (ctx, args) => {
        const w = await workerWorkspace(ctx, args); if ('failure' in w) return w.failure;
        try {
            const input = args as ScaffoldInput & { dir?: string };
            if (!isValidDriverType(input.type)) throw new DriverPackageError('invalid_arguments', 'type must be lowercase kebab-case (^[a-z][a-z0-9-]*$)');
            if (typeof input.name !== 'string' || !input.name.trim() || typeof input.command !== 'string' || !input.command.trim()
                || !Array.isArray(input.actions) || !input.actions.length || input.actions.length > 100) throw new DriverPackageError('invalid_arguments', 'name, command and at least one action are required');
            const dir = resolveInsideWorkspace(w.root, input.dir ?? `drivers/${input.type}`);
            try { lstatSync(dir); throw new DriverPackageError('already_exists', 'Target directory already exists'); }
            catch (error) { if (error instanceof DriverPackageError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const files = scaffoldDriverFiles(input);
            // The wrapped server's own files are added afterwards; driver_validate/export/install check references.
            const pkg = verifyDriverFiles(files, { checkReferences: false });
            for (const file of pkg.files) { const target = join(dir, file.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, file.bytes); }
            return { success: true, dir: relative(w.root, dir), files: pkg.files.map(f => f.path), report: pkg.report,
                next: 'Edit the files if needed, run driver_validate, then driver_export or driver_install.' };
        } catch (error) { return asFailure(error); }
    },
    driver_validate: async (ctx, args) => {
        const w = await workerWorkspace(ctx, args); if ('failure' in w) return w.failure;
        try { return { success: true, report: verifyDriverFiles(readDriverPackageDir(resolveInsideWorkspace(w.root, args?.dir))).report }; }
        catch (error) { return asFailure(error); }
    },
    driver_export: async (ctx, args) => {
        const w = await workerWorkspace(ctx, args); if ('failure' in w) return w.failure;
        try {
            const pkg = verifyDriverFiles(readDriverPackageDir(resolveInsideWorkspace(w.root, args?.dir)));
            const out = resolveInsideWorkspace(w.root, args?.out ?? `driver-bundles/${pkg.report.type}.driver-bundle.json`);
            if (!out.endsWith('.json')) throw new DriverPackageError('invalid_path', 'out must be a .json file (artifact kind json)');
            try { const stat = lstatSync(out); if (!stat.isFile() || stat.isSymbolicLink()) throw new DriverPackageError('invalid_path', 'out exists and is not a regular file'); }
            catch (error) { if (error instanceof DriverPackageError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const text = encodeDriverBundle(pkg);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, text);
            const path = relative(w.root, out);
            return { success: true, path, sizeBytes: Buffer.byteLength(text), treeDigest: pkg.report.treeDigest, report: pkg.report,
                next: `Share it: artifact_register {"path":"${path}"}. Another machine installs it with driver_install {artifact_id}.` };
        } catch (error) { return asFailure(error); }
    },
    driver_install: async (ctx, args) => {
        const w = await workerWorkspace(ctx, args); if ('failure' in w) return w.failure;
        try {
            const sources = ['dir', 'path', 'artifactId'].filter(k => args?.[k] !== undefined);
            if (sources.length !== 1) throw new DriverPackageError('invalid_arguments', 'Provide exactly one of dir, path or artifact_id');
            let pkg: VerifiedDriverPackage;
            if (args.dir !== undefined) pkg = verifyDriverFiles(readDriverPackageDir(resolveInsideWorkspace(w.root, args.dir)));
            else if (args.path !== undefined) pkg = decodeDriverBundle(readBundleFile(resolveInsideWorkspace(w.root, args.path)));
            else pkg = decodeDriverBundle(await fetchBundleArtifact(ctx, args));
            return await finishInstall(ctx, pkg, sources[0]!);
        } catch (error) { return asFailure(error); }
    },
    /** Owner dashboard: inline bundle text (the viewer already holds it) or an artifact id. */
    driver_import: async (ctx, args) => {
        try {
            if ((args?.bundle === undefined) === (args?.artifactId === undefined)) throw new DriverPackageError('invalid_arguments', 'Provide exactly one of bundle or artifactId');
            const text = args.bundle !== undefined ? String(args.bundle) : await fetchBundleArtifact(ctx, args);
            return await finishInstall(ctx, decodeDriverBundle(text), args.bundle !== undefined ? 'owner-inline' : 'owner-artifact');
        } catch (error) { return asFailure(error); }
    },
};

export const driverAuthoringSpecs = defineCommandSpecs('med', driverAuthoringHandlers, {
    driver_import: { sources: ['p2p', 'standalone'] },
}, { sources: ['ipc', 'standalone'] });
