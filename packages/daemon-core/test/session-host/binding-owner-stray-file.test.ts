import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { persistedBindingEvidence } from '../../src/session-host/binding-owner.js';

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

it('ignores a stray file beside the namespace dirs (macOS .DS_Store) when resolving a binding', () => {
    dir = mkdtempSync(join(tmpdir(), 'binding-owner-'));
    const runtimes = join(dir, 'session-host', 'adhdev-standalone', 'runtimes');
    mkdirSync(runtimes, { recursive: true });
    writeFileSync(join(dir, 'session-host', '.DS_Store'), 'finder');
    writeFileSync(join(runtimes, 'sess-1.json'), JSON.stringify({ record: { sessionId: 'sess-1', lifecycle: 'running' } }));
    const evidence = persistedBindingEvidence('sess-1', dir);
    expect(evidence.map(e => e.namespace)).toEqual(['adhdev-standalone']);
});
