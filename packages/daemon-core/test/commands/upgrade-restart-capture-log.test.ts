import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Source-shape guard: the post-upgrade daemon respawn must inherit the
 * capture-log fd, never discard its output.
 *
 * ★Why a source guard and not only a behavioural test: `spawnDetachedDaemonRestart`
 * is module-private and every one of its call sites is reached only at the end
 * of a real npm install / Windows pointer swap. There is no seam to drive it
 * from a unit test without faking away the exact line under test. What CAN be
 * asserted cheaply and without lying is the shape of the spawn options — which
 * is precisely what decides whether the child's stdout reaches the file.
 *
 * The regression: `stdio: 'ignore'` here meant every upgrade silently pointed
 * the replacement daemon's output at /dev/null. Because the daemon itself was
 * healthy and the structured `daemon-<date>.log` kept filling, the only visible
 * symptom was `daemon-service.log` freezing on the handoff line.
 *
 * Behavioural cover for the fd mechanics lives in
 * test/logging/capture-log-fd-wiring.test.ts.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE_HELPER = path.resolve(here, '../../src/commands/upgrade-helper.ts');

function readSource(): string {
    // Shape guards read the source by path, so an unreadable target must fail
    // loudly rather than vacuously pass (see check:shape-guards).
    expect(fs.existsSync(UPGRADE_HELPER), `guard target is missing: ${UPGRADE_HELPER}`).toBe(true);
    return fs.readFileSync(UPGRADE_HELPER, 'utf8');
}

/**
 * Drop comments so the guards match CODE only.
 *
 * Not cosmetic: the fix's own comment quotes the very `stdio: 'ignore'` string
 * it replaced, and a naive scan flagged that prose as the defect. A guard that
 * can be tripped by a comment describing the bug is a guard that will be
 * "fixed" by deleting the explanation.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Body of `function spawnDetachedDaemonRestart(...) { ... }`, comments removed. */
function extractRestartFn(rawSource: string): string {
    const source = stripComments(rawSource);
    const start = source.indexOf('function spawnDetachedDaemonRestart');
    expect(start, 'spawnDetachedDaemonRestart was renamed or removed').toBeGreaterThan(-1);

    // Walk braces from the first '{' after the signature.
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error('could not find the end of spawnDetachedDaemonRestart');
}

describe('spawnDetachedDaemonRestart capture-log wiring', () => {
    it('passes an inherited fd as stdout/stderr, not "ignore"', () => {
        const fn = extractRestartFn(readSource());

        expect(
            /stdio:\s*\[\s*'ignore'\s*,\s*outFd\s*,\s*outFd\s*\]/.test(fn),
            'the restarted daemon must inherit the capture-log fd for stdout AND stderr '
            + '(stdio: [\'ignore\', outFd, outFd]) — otherwise daemon-service.log stops '
            + 'growing after every upgrade while the daemon itself looks healthy',
        ).toBe(true);

        expect(
            /stdio:\s*'ignore'/.test(fn),
            'stdio: \'ignore\' discards the replacement daemon\'s stdout/stderr — this is the regression',
        ).toBe(false);
    });

    it('obtains the fd from the shared openCaptureLogFd helper and releases its own copy', () => {
        const fn = extractRestartFn(readSource());

        expect(
            fn.includes('openCaptureLogFd('),
            'use the shared helper so dir creation, rotation and the append open stay consistent '
            + 'across all daemon spawn sites — open-coding this wiring is how two sites were missed',
        ).toBe(true);

        expect(
            fn.includes('closeOutFd()'),
            'the spawning process must drop its fd copy so it does not hold the log open',
        ).toBe(true);
    });

    it('keeps the spawn shell-free and window-hidden', () => {
        const fn = extractRestartFn(readSource());

        expect(
            /windowsHide:\s*true/.test(fn),
            'a visible console window on win32 is the defect the fd wiring replaced the shell for',
        ).toBe(true);

        expect(
            /shell\s*:/.test(fn),
            'no shell: windowsHide cannot suppress a window created by a hidden shell\'s grandchild, '
            + 'so restoring `start /B ... >> log 2>&1` would reintroduce the console flash',
        ).toBe(false);
    });
});
