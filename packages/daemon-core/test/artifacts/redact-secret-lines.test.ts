import { describe, expect, it } from 'vitest';
import { assertNotSecretContent, redactSecretLines } from '../../src/artifacts/artifact-path-guard.js';

const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
const DIFF = [
    'diff --git a/tests/fixture.rs b/tests/fixture.rs',
    '@@ -1,3 +1,4 @@',
    ' fn fixture() {',
    `+    let token = "${TOKEN}";`,
    '-    let old = 1;',
    ' }',
].join('\n');

describe('redactSecretLines — a refused review diff can still be registered', () => {
    it('the raw diff is refused, the redacted one passes and keeps its diff columns', () => {
        expect(() => assertNotSecretContent(Buffer.from(DIFF), 'diff' as never)).toThrow(/secret_file_refused/);
        const { text, redactedLines } = redactSecretLines(DIFF);
        expect(redactedLines).toBe(1);
        expect(text).not.toContain(TOKEN);
        expect(text.split('\n')[3]).toBe('+[line redacted: matched a secret or token pattern]');
        expect(text.split('\n')[4]).toBe('-    let old = 1;');
        expect(() => assertNotSecretContent(Buffer.from(text), 'diff' as never)).not.toThrow();
    });

    it('leaves clean text untouched', () => {
        expect(redactSecretLines('a\n+b\n-c')).toEqual({ text: 'a\n+b\n-c', redactedLines: 0 });
    });
});
