/**
 * `project_send` message composition (design 2026-10-07-assistant-layer.md
 * §4.3 step 3, §4.10.5).
 *
 * Order: the user's words as written → the assistant's supplement (under
 * `SUPPLEMENT_LABEL`) → one framed `## Attached procedure: <name>` block per
 * attached skill (SKILL.md body only, never reference files). At most 2
 * skills; attachments over 12,000 chars in total are refused
 * (`skill_attach_too_large`), never truncated.
 */

import { isValidSkillName, type SkillOrigin } from './skills/skill-format.js';
import { renderAttachedProcedure } from './skills/skill-index.js';

export const PROJECT_SEND_MAX_SKILLS = 2;
export const PROJECT_SEND_ATTACH_MAX_CHARS = 12_000;
/** Heads the supplement so the coordinator never mistakes it for the user's words. */
export const SUPPLEMENT_LABEL = "Added by the user's assistant (not the user's words):";

export interface AttachSkillSource {
    readForAttach(name: string): { name: string; origin: SkillOrigin; body: string } | null;
}

export type ComposeProjectMessageResult =
    | { ok: true; text: string; attached: string[] }
    | { ok: false; code: 'invalid_args'; error: string }
    | { ok: false; code: 'skill_not_found'; error: string; skill: string }
    | { ok: false; code: 'skill_attach_too_large'; error: string; chars: number; limit: number };

export function composeProjectMessage(
    input: { message: string; supplement?: string; skills?: readonly string[] },
    skills: AttachSkillSource,
): ComposeProjectMessageResult {
    if (!input.message.trim()) return { ok: false, code: 'invalid_args', error: 'message required' };
    const names = [...new Set((input.skills ?? []).map((s) => s.trim()).filter(Boolean))];
    if (names.length > PROJECT_SEND_MAX_SKILLS) {
        return { ok: false, code: 'invalid_args', error: `at most ${PROJECT_SEND_MAX_SKILLS} skills can be attached` };
    }
    const blocks: string[] = [];
    for (const name of names) {
        const skill = isValidSkillName(name) ? skills.readForAttach(name) : null;
        if (!skill) return { ok: false, code: 'skill_not_found', error: `skill not found or unreadable: ${name}`, skill: name };
        blocks.push(renderAttachedProcedure(skill));
    }
    const chars = blocks.reduce((n, b) => n + b.length, 0);
    if (chars > PROJECT_SEND_ATTACH_MAX_CHARS) {
        return { ok: false, code: 'skill_attach_too_large', error: 'skill_attach_too_large', chars, limit: PROJECT_SEND_ATTACH_MAX_CHARS };
    }
    const supplement = input.supplement?.trim();
    const text = [input.message, ...(supplement ? [`${SUPPLEMENT_LABEL}\n${supplement}`] : []), ...blocks].join('\n\n');
    return { ok: true, text, attached: names };
}
