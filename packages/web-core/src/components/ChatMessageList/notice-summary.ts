/**
 * notice-summary — the user-facing sentence for a daemon notice chip.
 *
 * The daemon writes its notices in English for the assistant
 * (daemon-core assistant/assistant-relay-format.ts and assistant-relay.ts).
 * The chip shows the owner the same fact in their language. Each row below
 * mirrors one builder; a notice no row recognises keeps its original text, so
 * a new daemon format is never hidden. The original English stays the chip's
 * copy text and tooltip.
 *
 * Pure: returns an i18n key and values, never translated text.
 */

import type { InjectedSegment } from './injected-text';

export interface NoticeSummary {
    key: string;
    values?: Record<string, string | number>;
}

type Rule = { re: RegExp; key: string; values?: (m: RegExpExecArray) => Record<string, string | number> };

/** `[project <slug>] …` one-line signals. */
const SIGNAL_RULES: readonly Rule[] = [
    { re: /^no progress for 30 min: (\d+) pending, 0 assigned, (\d+) active missions?/, key: 'chat.notice.stall', values: (m) => ({ pending: Number(m[1]), missions: Number(m[2]) }) },
    { re: /^still working after 30 min without a result/, key: 'chat.notice.progress' },
    { re: /^waiting for an approval or a choice/, key: 'chat.notice.approval' },
    { re: /^the project's agent session ended/, key: 'chat.notice.sessionEnded' },
    { re: /^(\d+) earlier turns? older than 24 h were not relayed/, key: 'chat.notice.oldTurns', values: (m) => ({ count: Number(m[1]) }) },
];

/** `[ADHDev <kind>] …` notices, by header kind and, where one kind has several texts, by body. */
const NOTICE_RULES: Readonly<Record<string, readonly Rule[]>> = {
    'relay gap': [
        { re: /^(\d+) coordinator reports? did not reach you in full/, key: 'chat.notice.missedReports', values: (m) => ({ count: Number(m[1]) }) },
        { re: /^A coordinator reply at /, key: 'chat.notice.replyGap' },
    ],
    restart: [{ re: /^The previous assistant session ended/, key: 'chat.notice.restart' }],
    relay: [{ re: /^This report may be truncated/, key: 'chat.notice.relayTruncated' }],
    'terminal delivery uncertainty': [{ re: /^/, key: 'chat.notice.deliveryUncertain' }],
    'report references': [{ re: /^/, key: 'chat.notice.reportReferences' }],
    'original report unavailable': [{ re: /^/, key: 'chat.notice.reportUnavailable' }],
};

function apply(rules: readonly Rule[] | undefined, body: string): NoticeSummary | null {
    for (const rule of rules ?? []) {
        const m = rule.re.exec(body);
        if (m) return rule.values ? { key: rule.key, values: rule.values(m) } : { key: rule.key };
    }
    return null;
}

export function summarizeNotice(segment: InjectedSegment): NoticeSummary | null {
    const body = segment.body.trim();
    if (segment.source === 'signal') return apply(SIGNAL_RULES, body);
    if (segment.source === 'notice' && segment.noticeKind) return apply(NOTICE_RULES[segment.noticeKind], body);
    return null;
}
