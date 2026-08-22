import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    rotateCaptureLogIfNeeded,
    rotateSizeGenerations,
    MAX_CAPTURE_LOG_SIZE,
    MAX_CAPTURE_LOG_GENERATIONS,
} from '../../src/logging/logger.js';

/**
 * Retention cover for the RAW STDIO-CAPTURE logs.
 *
 * `daemon-service.log` and `daemon-launchd.out` are not written through the
 * logger — they are a child's stdout/stderr, wired as an append fd or a shell
 * `>>` redirect. Nothing in the write path could bound them: rotation existed on
 * exactly one code path (`service restart`) and retention on none, because
 * `cleanOldLogs` only matches `daemon-<date>`. Observed result: a 44MB
 * daemon-service.log and a 36MB daemon-launchd.out.
 */

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhdev-capture-log-'));
});

afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
});

function write(file: string, bytes: number): string {
    const p = path.join(dir, file);
    fs.writeFileSync(p, Buffer.alloc(bytes, 'x'));
    return p;
}

describe('rotateCaptureLogIfNeeded', () => {
    it('does nothing when the file is under the cap', () => {
        const p = write('daemon-service.log', 1024);
        expect(rotateCaptureLogIfNeeded(p, 4096)).toBe(false);
        expect(fs.existsSync(p)).toBe(true);
        expect(fs.existsSync(path.join(dir, 'daemon-service.1.log'))).toBe(false);
    });

    it('does nothing when the file does not exist', () => {
        expect(rotateCaptureLogIfNeeded(path.join(dir, 'nope.log'), 4096)).toBe(false);
    });

    it('rotates a file past the cap and frees the active path', () => {
        const p = write('daemon-service.log', 8192);
        expect(rotateCaptureLogIfNeeded(p, 4096)).toBe(true);
        // Active path is now free for the next append; the old content survives
        // one generation back.
        expect(fs.existsSync(p)).toBe(false);
        expect(fs.statSync(path.join(dir, 'daemon-service.1.log')).size).toBe(8192);
    });

    /**
     * The `.out` case. `sizeRotationPath` used a hardcoded `/\.log$/` replace, so
     * daemon-launchd.out kept its own name for every generation and each rotation
     * renamed the file onto itself — losing history and never actually bounding
     * the set. Reverting the generic-suffix fix turns this red.
     */
    it('rotates a non-.log capture file (daemon-launchd.out) into distinct generations', () => {
        const p = write('daemon-launchd.out', 8192);
        expect(rotateCaptureLogIfNeeded(p, 4096)).toBe(true);
        expect(fs.existsSync(p)).toBe(false);

        const rotated = path.join(dir, 'daemon-launchd.1.out');
        expect(fs.existsSync(rotated)).toBe(true);
        expect(fs.statSync(rotated).size).toBe(8192);
    });

    it('bounds total retained history to the generation cap', () => {
        const active = path.join(dir, 'daemon-service.log');

        // Rotate more times than the cap allows; each round writes a fresh
        // oversized active file.
        for (let i = 0; i < MAX_CAPTURE_LOG_GENERATIONS + 3; i++) {
            fs.writeFileSync(active, Buffer.alloc(8192, 'x'));
            rotateCaptureLogIfNeeded(active, 4096);
        }

        const retained = fs.readdirSync(dir).filter(f => f.startsWith('daemon-service'));
        // At most `MAX_CAPTURE_LOG_GENERATIONS` rotated files survive — the whole
        // point is that this set cannot grow without limit.
        expect(retained.length).toBeLessThanOrEqual(MAX_CAPTURE_LOG_GENERATIONS);
        expect(fs.existsSync(path.join(dir, `daemon-service.${MAX_CAPTURE_LOG_GENERATIONS + 1}.log`))).toBe(false);
    });

    it('defaults to a 10MB cap', () => {
        expect(MAX_CAPTURE_LOG_SIZE).toBe(10 * 1024 * 1024);
        // A file just under the default cap is left alone by the default call.
        const p = write('daemon-service.log', 1024);
        expect(rotateCaptureLogIfNeeded(p)).toBe(false);
    });

    it('never throws on an unwritable/odd path', () => {
        expect(() => rotateCaptureLogIfNeeded(path.join(dir, 'missing', 'x.log'))).not.toThrow();
    });
});

describe('rotateSizeGenerations suffix handling', () => {
    it('keeps the existing daemon-<date>.log → .1.log layout intact', () => {
        // Regression guard: the generic-suffix rewrite must not change the
        // established naming that every log reader (mesh get_mesh_node_logs,
        // diagnostics get_logs, runbooks) depends on.
        const p = write('daemon-2026-08-22.log', 16);
        rotateSizeGenerations(p, 3);
        expect(fs.existsSync(path.join(dir, 'daemon-2026-08-22.1.log'))).toBe(true);
    });

    it('keeps the per-instance daemon-<port>-<date>.log layout intact', () => {
        const p = write('daemon-19223-2026-08-22.log', 16);
        rotateSizeGenerations(p, 3);
        expect(fs.existsSync(path.join(dir, 'daemon-19223-2026-08-22.1.log'))).toBe(true);
    });

    it('shifts generations and drops the oldest', () => {
        const base = path.join(dir, 'daemon-service.log');
        fs.writeFileSync(path.join(dir, 'daemon-service.1.log'), 'gen1');
        fs.writeFileSync(path.join(dir, 'daemon-service.2.log'), 'gen2');
        fs.writeFileSync(base, 'active');

        rotateSizeGenerations(base, 2);

        // active → .1, previous .1 → .2, previous .2 dropped.
        expect(fs.readFileSync(path.join(dir, 'daemon-service.1.log'), 'utf-8')).toBe('active');
        expect(fs.readFileSync(path.join(dir, 'daemon-service.2.log'), 'utf-8')).toBe('gen1');
        expect(fs.existsSync(base)).toBe(false);
    });

    it('appends the generation for an extensionless file', () => {
        const p = write('capture', 16);
        rotateSizeGenerations(p, 2);
        expect(fs.existsSync(path.join(dir, 'capture.1'))).toBe(true);
    });
});
