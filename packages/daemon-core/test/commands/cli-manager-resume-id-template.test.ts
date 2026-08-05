import { describe, expect, it } from 'vitest';

import { resolveCliSessionBinding } from '../../src/commands/cli-manager.js';

// KIMI RESUME — the session id a CLI accepts is not always the id we stored.
//
// kimi keys its own sessions as `session_<uuid>` (see ~/.kimi-code/session_index.jsonl
// and the `kimi -r session_<uuid>` hint it prints), but adhdev stores the BARE
// uuid because the native-history executor extracts it from the directory name
// (`session_id_from: "dir_uuid"`). Resuming therefore ran `kimi -S <bare-uuid>`,
// which answers:
//
//     error: failed to run prompt: Session "<uuid>" not found.
//
// Verified live against kimi-code on both saved sessions: the bare form fails,
// the `session_`-prefixed form resumes and replies. The fix lets a provider spec
// express the decoration (`"-S", "session_{{id}}"`), which requires `{{id}}` to
// substitute INSIDE a part rather than only when the part is exactly `{{id}}`.
//
// kimi's own log (~/.kimi-code/logs/kimi-code.log) shows BOTH failure modes and
// distinguishes them, which is what pins the id form as the defect here:
//
//   Session "<bare-uuid>" not found.                        <- wrong id FORM
//   Session "session_<uuid>" was created under a different directory.
//
// The second only appears when the prefixed id RESOLVES — so kimi additionally
// requires the resume to run from the session's original workDir. adhdev already
// satisfies that (provider-cli-runtime spawns with cwd = the launch workspace,
// and the saved record carries that same workspace), so it is a precondition to
// respect rather than a second bug; the assertion below locks the id form, which
// is the part adhdev was getting wrong.

/** Minimal provider shape the binding resolver reads. */
function providerWith(resumeSessionArgs: string[]) {
    return {
        name: 'kimi',
        displayName: 'Kimi Code',
        resume: {
            supported: true,
            sessionIdFormat: 'string',
            resumeSessionArgs,
        },
    } as any;
}

const UUID = '3ea375d1-9a4c-4b55-bfee-96a253a422ec';

describe('resume id templating', () => {
    it('substitutes {{id}} inside a decorated part (kimi needs session_<uuid>)', () => {
        const binding = resolveCliSessionBinding(providerWith(['-S', 'session_{{id}}']), 'kimi', [], UUID);

        // The exact argv that resumed successfully when run by hand.
        expect(binding.cliArgs).toEqual(['-S', `session_${UUID}`]);
        expect(binding.launchMode).toBe('resume');
        // The id adhdev tracks stays the bare uuid — only the argv is decorated,
        // so saved-session identity and native-history lookup are unaffected.
        expect(binding.providerSessionId).toBe(UUID);
    });

    it('does not double-decorate an id that already carries the prefix', () => {
        // Both forms circulate for kimi: the executor extracts a bare uuid from
        // the directory name, while a pin / `kimi -r` hint carries the prefixed
        // form. `session_session_<uuid>` would fail exactly like the original bug.
        const binding = resolveCliSessionBinding(
            providerWith(['-S', 'session_{{id}}']), 'kimi', [], `session_${UUID}`,
        );
        expect(binding.cliArgs).toEqual(['-S', `session_${UUID}`]);
        expect(binding.cliArgs?.join(' ')).not.toContain('session_session_');
    });

    it('leaves an undecorated template exactly as before (claude/codex/cursor)', () => {
        // Every other CLI takes the id as its own argv entry. This is the
        // regression guard for the shared launch path.
        for (const template of [['--resume', '{{id}}'], ['resume', '{{id}}']]) {
            const binding = resolveCliSessionBinding(providerWith(template), 'claude-cli', [], UUID);
            expect(binding.cliArgs).toEqual([template[0], UUID]);
        }
    });

    it('keeps any caller-supplied args ahead of the resume args', () => {
        const binding = resolveCliSessionBinding(
            providerWith(['-S', 'session_{{id}}']), 'kimi', ['--yolo'], UUID,
        );
        expect(binding.cliArgs).toEqual(['--yolo', '-S', `session_${UUID}`]);
    });
});

// SHIPPED-SPEC GATE — the unit tests above prove the expansion is correct for a
// spec that carries the decoration. They cannot fail when the decoration is
// missing from the manifest we actually publish, which is precisely how this
// defect survived a "fix": the code was right, and kimi's own provider.v1.json
// in an earlier published version still said `["-S", "{{id}}"]`.
//
// A daemon resolves providers from the content-addressed channel store, so a
// machine keeps running the pinned version until check_provider_updates flips
// the pointer. That makes a wrong manifest expensive — it ships, pins, and then
// looks like a code bug on every machine that pinned it. This asserts the source
// of truth in this repo, so the manifest can never silently lose the prefix.
describe('shipped kimi manifest', () => {
    it('declares the session_ decoration kimi requires to resume', async () => {
        const { readFileSync } = await import('node:fs');
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');

        const here = dirname(fileURLToPath(import.meta.url));
        const manifestPath = join(here, '../../../../../adhdev-providers/cli/kimi/provider.v1.json');
        const spec = JSON.parse(readFileSync(manifestPath, 'utf-8'));

        expect(spec.resume?.resumeSessionArgs).toEqual(['-S', 'session_{{id}}']);

        // And the expansion of that shipped template must produce the argv that
        // kimi actually accepts — bare uuid is the failure mode we shipped once.
        const binding = resolveCliSessionBinding(
            providerWith(spec.resume.resumeSessionArgs), 'kimi', [], UUID,
        );
        expect(binding.cliArgs).toEqual(['-S', `session_${UUID}`]);
    });
});
