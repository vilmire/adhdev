import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBoth, readTree, setupPair, waitFor } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('A01 normal transfer', () => {
  it('delivers a multi-file tree into a NEW folder with matching bytes', async () => {
    const big = Buffer.alloc(2_500_000, 7); // spans 3 blocks
    const t = await setupPair({
      'proj/readme.md': 'hello',
      'proj/src/a.ts': 'export const a = 1\n',
      'proj/src/deep/b.bin': big,
      'proj/empty.txt': '',
      'proj/emptydir/': '',
    });
    cleanups.push(() => { t.a.engine.shutdown(); t.b.engine.shutdown(); });
    const [ra, rb] = await approveBoth(t.a, t.b, t.id, t.rec.selectionDigest);
    expect(ra.ok && rb.ok).toBe(true);
    const done = await waitFor(() => t.b.engine.get(t.id)?.state === 'completed' && t.a.engine.get(t.id)?.state === 'completed');
    expect(done).toBe(true);
    const published = t.b.engine.get(t.id)!.publishedName!;
    expect(published).toBe('incoming');
    const got = readTree(path.join(t.b.ws.path, published));
    const want = readTree(path.join(t.a.ws.path));
    expect(got['proj/src/deep/b.bin']).toBe(want['proj/src/deep/b.bin']);
    expect(got['proj/readme.md']).toBe('hello');
    expect(got['proj/empty.txt']).toBe('');
    expect(got['proj/emptydir/']).toBe('');
    // staging is gone, spool is gone
    expect(fs.existsSync(path.join(t.b.ws.path, '.adhdev-transfer-staging'))).toBe(false);
    expect(fs.existsSync(t.a.engine.store.spoolDir(t.id))).toBe(false);
  });
});
