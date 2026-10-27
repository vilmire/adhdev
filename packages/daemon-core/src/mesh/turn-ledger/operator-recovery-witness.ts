import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assertTestStorageIsolated, recoveryTargetBytes, type RecoveryOwnerAdmission } from '@adhdev/session-host-core';

/** Independent from mesh-runtime.db: the irreversible burn is fsynced BEFORE
 * SQLite consumption. A crash can refuse recovery, never authorize replay.
 * No implicit re-enrollment, deletion, release, repair, or truncation API. */
export class RecoveryWitness {
    private readonly marker: string;
    private readonly burnFile: string;
    private readonly enrollmentBytes: string;
    private burned = false;
    constructor(private readonly root: string) {
        assertTestStorageIsolated(root);
        this.marker = path.join(root, 'enrollment.json');
        this.burnFile = path.join(root, 'consumed.json');
        this.enrollmentBytes = this.read(this.marker);
        const e = JSON.parse(this.enrollmentBytes);
        if (e.protocol !== 1 || e.target !== recoveryTargetBytes || !/^[a-f0-9]{64}$/.test(e.random)) throw new Error('recovery_witness_untrusted');
    }
    static enroll(root: string, owner: RecoveryOwnerAdmission, grant: unknown): RecoveryWitness {
        assertTestStorageIsolated(root);
        owner.reserve(grant, 'witness_enroll')();
        // The directory itself is the never-reused enrollment marker. A partial
        // initialization must be inspected, not automatically re-created.
        fs.mkdirSync(root, { mode: 0o700 });
        const bytes = JSON.stringify({ protocol: 1, target: recoveryTargetBytes, random: randomBytes(32).toString('hex') });
        const file = path.join(root, 'enrollment.json');
        const fd = fs.openSync(file, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        RecoveryWitness.syncDir(root); RecoveryWitness.syncDir(path.dirname(root));
        return new RecoveryWitness(root);
    }
    private static syncDir(dir: string): void {
        const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    private read(file: string): string {
        const dir = fs.lstatSync(this.root);
        if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error('recovery_witness_untrusted');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const s = fs.fstatSync(fd);
            if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw new Error('recovery_witness_untrusted');
            return fs.readFileSync(fd, 'utf8');
        } finally { fs.closeSync(fd); }
    }
    assertAvailable(): void {
        if (this.burned) throw new Error('recovery_witness_consumed');
        if (this.read(this.marker) !== this.enrollmentBytes) throw new Error('recovery_witness_rollback');
        // lstat also detects symlinks and a partial/corrupt burn as consumed.
        try { fs.lstatSync(this.burnFile); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
        throw new Error('recovery_witness_consumed');
    }
    burn(nonceHash: string, proofHash: string): void {
        this.assertAvailable();
        if (!/^[a-f0-9]{64}$/.test(nonceHash) || !/^[a-f0-9]{64}$/.test(proofHash)) throw new Error('recovery_witness_digest_required');
        const fd = fs.openSync(this.burnFile, 'wx', 0o600);
        this.burned = true;
        try {
            fs.writeFileSync(fd, JSON.stringify({ target: recoveryTargetBytes, nonceHash, proofHash,
                enrollmentHash: createHash('sha256').update(this.enrollmentBytes).digest('hex') }));
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        RecoveryWitness.syncDir(this.root);
        // A second durable spent marker detects loss of the burn file alone.
        // A partial append is deliberately unreadable on the next boot.
        const marker = fs.openSync(this.marker, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
        try { fs.writeFileSync(marker, `\nCONSUMED:${nonceHash}`); fs.fsyncSync(marker); }
        finally { fs.closeSync(marker); }
    }
}
