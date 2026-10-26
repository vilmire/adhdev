import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

test('standalone typecheck rebuilds referenced declarations after web-core output cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'web-project-reference-'));
    try {
        for (const name of ['web-core', 'web-standalone']) {
            mkdirSync(join(root, name, 'src'), { recursive: true });
            writeFileSync(join(root, name, 'tsconfig.json'),
                readFileSync(new URL(`../../${name}/tsconfig.json`, import.meta.url)));
        }
        writeFileSync(join(root, 'web-core/src/index.ts'), 'export const value = 42;\n');
        writeFileSync(join(root, 'web-standalone/src/index.ts'),
            "import { value } from '../../web-core/src/index.js';\nexport const doubled = value * 2;\n");
        const typecheck = () => {
            const result = spawnSync(process.execPath,
                [tsc, '-b', join(root, 'web-standalone/tsconfig.json')],
                { encoding: 'utf8', windowsHide: true });
            assert.equal(result.status, 0, `${result.error?.message ?? ''}${result.stdout}${result.stderr}`);
        };

        typecheck();
        const declaration = join(root, 'web-core/dist/index.d.ts');
        const expected = readFileSync(declaration, 'utf8');
        // A cache outside dist used to survive cleanup and skip this missing reference.
        rmSync(join(root, 'web-core/dist'), { recursive: true, force: true });
        assert.equal(existsSync(declaration), false);

        typecheck();
        assert.equal(readFileSync(declaration, 'utf8'), expected);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
