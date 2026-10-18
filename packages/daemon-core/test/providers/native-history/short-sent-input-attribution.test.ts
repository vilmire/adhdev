import { afterEach, describe, expect, it } from 'vitest';
import { hasExclusiveSentInput, recordSentPrompt, releaseSentPrompts } from '../../../src/providers/native-history/sent-prompt-registry.js';

/**
 * 2026-10-18 (preview): an antigravity session whose only prompts were "dd"
 * and "dd?" was never bound to its conversation — inputs under 8 characters
 * were not recorded — so the dashboard showed the owner's bubbles and no reply.
 */
describe('short sent inputs as ownership evidence', () => {
    afterEach(() => { releaseSentPrompts('a'); releaseSentPrompts('b'); });

    it('an exact short input proves ownership', () => {
        recordSentPrompt('a', 'dd');
        recordSentPrompt('a', 'dd?');
        expect(hasExclusiveSentInput('a', ['dd', 'dd?'])).toBe(true);
    });

    it('never as a substring: "ok" inside a longer message is not evidence', () => {
        recordSentPrompt('a', 'ok');
        expect(hasExclusiveSentInput('a', ['ok, deploy it now please'])).toBe(false);
    });

    it('the same short input sent by two sessions proves nothing', () => {
        recordSentPrompt('a', 'dd');
        recordSentPrompt('b', 'dd');
        expect(hasExclusiveSentInput('a', ['dd'])).toBe(false);
        expect(hasExclusiveSentInput('b', ['dd'])).toBe(false);
    });

    it('a store holding exclusive input of two sessions stays ambiguous', () => {
        recordSentPrompt('a', 'dd');
        recordSentPrompt('b', 'run the full test suite');
        expect(hasExclusiveSentInput('a', ['dd', 'run the full test suite'])).toBe(false);
    });

    it('a single character is still ignored', () => {
        recordSentPrompt('a', 'y');
        expect(hasExclusiveSentInput('a', ['y'])).toBe(false);
    });
});
