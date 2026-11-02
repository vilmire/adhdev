/** Project-scoped approval files only. No config/auth/provider credential files
 * or executable/driver packages travel. Originals are never removed. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

export interface ProjectApprovalFile {
    area: 'staged' | 'staged-control';
    name: string;
    meshId: string;
    sha256: string;
    data: string;
}
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const record = (v: unknown): Record<string, any> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;

function readProposal(file: ProjectApprovalFile): { value: Record<string, any>; reference: string } {
    if (!['staged', 'staged-control'].includes(file.area) || !/^[A-Za-z0-9_-]+\.json$/.test(file.name)
        || typeof file.data !== 'string' || Buffer.byteLength(file.data) > MAX_FILE_BYTES || digest(file.data) !== file.sha256) throw new Error('invalid project approval file');
    const value = record(JSON.parse(file.data));
    if (!value || value.id !== file.name.slice(0, -5)) throw new Error('approval file identity mismatch');
    const allowed = file.area === 'staged-control' ? ['session_control', 'host_handoff'] : ['note', 'memory', 'launch_defaults'];
    if (!allowed.includes(value.kind)) throw new Error('unsupported project approval kind');
    if (value.kind === 'memory' && value.op?.scope !== 'project'
        || value.kind === 'session_control' && value.role === 'assistant') throw new Error('global approval cannot migrate with a project');
    const reference = value.meshId ?? value.op?.projectRef ?? value.project;
    if (typeof reference !== 'string' || !reference) throw new Error('project approval has no stable project reference');
    return { value, reference };
}

export function verifyProjectApprovalFiles(files: ProjectApprovalFile[], meshId: string, resolveProject: (reference: string) => string | null = ref => ref): void {
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error('approval file count exceeds bound');
    const seen = new Set<string>();
    let bytes = 0;
    for (const file of files) {
        const { reference } = readProposal(file);
        if (file.meshId !== meshId) throw new Error('approval belongs to another project');
        if (resolveProject(reference) !== meshId) throw new Error('approval payload belongs to another project');
        const key = `${file.area}/${file.name}`;
        if (seen.has(key)) throw new Error('duplicate approval file');
        seen.add(key);
        bytes += Buffer.byteLength(file.data);
    }
    if (bytes > MAX_BYTES) throw new Error('approval files exceed byte bound');
}

function safeDir(configDir: string, area: ProjectApprovalFile['area'], create: boolean): string {
    const root = realpathSync(configDir);
    for (const component of ['assistant', area]) {
        const parent = component === 'assistant' ? configDir : join(configDir, 'assistant');
        const path = join(parent, component);
        if (existsSync(path)) {
            const stat = lstatSync(path);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('approval directory is not a local directory');
        } else if (create) mkdirSync(path, { mode: 0o700 });
        else return path;
    }
    const dir = join(configDir, 'assistant', area);
    const rel = relative(root, realpathSync(dir));
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('approval directory escaped config');
    return dir;
}

export function exportProjectApprovalFiles(configDir: string, meshId: string, resolveProject: (reference: string) => string | null): ProjectApprovalFile[] {
    const files: ProjectApprovalFile[] = [];
    for (const area of ['staged', 'staged-control'] as const) {
        const dir = safeDir(configDir, area, false);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir).sort()) {
            if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
            const path = join(dir, name);
            const stat = lstatSync(path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('approval file is not a bounded local file');
            const data = readFileSync(path, 'utf8');
            const value = record(JSON.parse(data));
            if (!value) throw new Error('approval record is unreadable');
            // Global memory and global assistant controls remain on their machine.
            if (value.kind === 'memory' && value.op?.scope !== 'project'
                || value.kind === 'session_control' && value.role === 'assistant') continue;
            const ref = value.meshId ?? value.op?.projectRef ?? value.project;
            if (typeof ref !== 'string' || resolveProject(ref) !== meshId) continue;
            const file: ProjectApprovalFile = { area, name, meshId, sha256: digest(data), data };
            readProposal(file);
            files.push(file);
        }
    }
    verifyProjectApprovalFiles(files, meshId, resolveProject);
    return files;
}

/** Validate every destination before effects. New files are installed without
 * replacing an existing inode; a crash/retry accepts only identical bytes. */
export function importProjectApprovalFiles(configDir: string, meshId: string, files: ProjectApprovalFile[], resolveProject?: (reference: string) => string | null): void {
    verifyProjectApprovalFiles(files, meshId, resolveProject);
    const verifyExisting = (path: string, data: string) => {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(path, 'utf8') !== data) throw new Error('approval destination conflicts with retained data');
    };
    const destinations = files.map(file => {
        const path = join(safeDir(configDir, file.area, true), file.name);
        if (existsSync(path)) {
            verifyExisting(path, file.data);
        }
        return { file, path };
    });
    for (const { file, path } of destinations) {
        if (existsSync(path)) { verifyExisting(path, file.data); continue; }
        const staged = `${path}.handoff-${file.sha256}`;
        if (!existsSync(staged)) {
            const fd = openSync(staged, 'wx', 0o600);
            try { writeFileSync(fd, file.data); fsyncSync(fd); } finally { closeSync(fd); }
        } else if (lstatSync(staged).isSymbolicLink() || readFileSync(staged, 'utf8') !== file.data) throw new Error('approval staging conflict');
        try { linkSync(staged, path); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            verifyExisting(path, file.data);
        }
        if (process.platform !== 'win32') {
            const fd = openSync(join(configDir, 'assistant', file.area), 'r');
            try { fsyncSync(fd); } finally { closeSync(fd); }
        }
    }
}
