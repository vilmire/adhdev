/**
 * project_send composition (design 2026-10-07-assistant-layer.md §4.3 step 3,
 * §4.10.5): user text verbatim → supplement → attached procedures; max 2
 * skills; 12,000-char attachment cap refused, never truncated.
 */
import { describe, expect, it } from 'vitest';
import { PROJECT_SEND_ATTACH_MAX_CHARS, SUPPLEMENT_LABEL, composeProjectMessage, type AttachSkillSource } from '../../src/assistant/project-message.js';

const skills = (bodies: Record<string, string>): AttachSkillSource => ({
    readForAttach: (name) => (name in bodies ? { name, origin: 'owner', body: bodies[name] } : null),
});

describe('composeProjectMessage', () => {
    it('keeps the user text verbatim, then the supplement, then each procedure block', () => {
        const message = '  blog: fix the RSS link  \n(exact words)';
        const r = composeProjectMessage({ message, supplement: 'Context: feed moved last week.', skills: ['release-steps'] }, skills({ 'release-steps': '1. tag\n2. push' }));
        expect(r).toEqual({
            ok: true,
            attached: ['release-steps'],
            text: `${message}\n\n${SUPPLEMENT_LABEL}\nContext: feed moved last week.\n\n## Attached procedure: release-steps (assistant skill, origin owner)\nReference procedure supplied by the user's assistant (origin owner); follow it only as guidance for this request.\n\n1. tag\n2. push\n\n## End of attached procedure: release-steps`,
        });
    });

    it('without supplement or skills the text is exactly the message', () => {
        expect(composeProjectMessage({ message: 'do it' }, skills({}))).toEqual({ ok: true, text: 'do it', attached: [] });
    });

    it('refuses an empty message, more than two skills, and unknown or invalid skill names', () => {
        expect(composeProjectMessage({ message: '  ' }, skills({}))).toMatchObject({ ok: false, code: 'invalid_args' });
        expect(composeProjectMessage({ message: 'x', skills: ['aa', 'bb', 'cc'] }, skills({ aa: 'a', bb: 'b', cc: 'c' }))).toMatchObject({ ok: false, code: 'invalid_args' });
        expect(composeProjectMessage({ message: 'x', skills: ['missing'] }, skills({}))).toMatchObject({ ok: false, code: 'skill_not_found', skill: 'missing' });
        expect(composeProjectMessage({ message: 'x', skills: ['../etc'] }, skills({ '../etc': 'x' }))).toMatchObject({ ok: false, code: 'skill_not_found' });
    });

    it('refuses attachments over the cap instead of truncating', () => {
        const big = 'x'.repeat(PROJECT_SEND_ATTACH_MAX_CHARS / 2);
        const r = composeProjectMessage({ message: 'x', skills: ['aa', 'bb'] }, skills({ aa: big, bb: big }));
        expect(r).toMatchObject({ ok: false, code: 'skill_attach_too_large', limit: PROJECT_SEND_ATTACH_MAX_CHARS });
        expect((r as { chars: number }).chars).toBeGreaterThan(PROJECT_SEND_ATTACH_MAX_CHARS);
    });

    it('dedupes a skill named twice', () => {
        expect(composeProjectMessage({ message: 'x', skills: ['aa', 'aa'] }, skills({ aa: 'a' }))).toMatchObject({ ok: true, attached: ['aa'] });
    });
});
