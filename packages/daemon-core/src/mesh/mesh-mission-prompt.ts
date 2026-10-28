/**
 * Coordinator-prompt rendering of active missions (structured-missions design
 * 2026-10-28 §7, §5.3).
 *
 * Replaces the old "dump the whole goal" section: each mission renders as a
 * compact block (≤ MISSION_BLOCK_CHAR_CAP chars) — title, summary (fallback: the
 * start of the goal), open-item counts, each OPEN owner decision as one line, and
 * decisions the owner answered since the coordinator last saw them. The full goal
 * text stays in `mesh_mission_list verbose`.
 *
 * "Seen" tracking (answered decisions): a per-item watermark
 * `decision.promptAckedAt` (stored in `decision_json`, no schema change). An
 * answered decision is shown while `promptAckedAt` is absent or older than
 * `answer.at` (so a CHANGED answer re-surfaces). Building the section is a pure
 * read — repeated builds are identical; the watermark is advanced only by
 * `acknowledgeAnsweredDecisions`, which the daemon calls when the coordinator
 * writes that mission through `mesh_mission_upsert` (it demonstrably has the
 * state) — and an answer whose delivery message was acked counts as seen too.
 */
import type { MissionItemRecord } from './mesh-mission-items-store.js';
import { MeshRuntimeStore } from './mesh-runtime-store.js';
import { getActiveMeshMissionSummaries, type MeshMissionSummary } from './mesh-missions.js';
import { isCarryOverMissionRecord, truncateMissionText, type MissionDecision } from '@adhdev/mesh-shared';

/** Hard cap on one mission's rendered block (header, summary, counts, tasks, decisions, hints). */
export const MISSION_BLOCK_CHAR_CAP = 600;
const SUMMARY_MAX = 200;
const GOAL_FALLBACK_MAX = 160;
const TITLE_MAX = 60;
const QUESTION_MAX = 70;
const LABEL_MAX = 24;
const MORE_LINE_RESERVE = 14; // "  +99 more …"

export const MISSION_MIGRATION_HINT =
    'Migrate: on your next update of this mission, add a summary + items (mesh_mission_upsert summary / items_add).';

function decisionOf(item: MissionItemRecord): MissionDecision | undefined {
    return item.decision && typeof item.decision === 'object' ? item.decision : undefined;
}

/** True when the answer was recorded and the coordinator has not yet seen it. */
export function isUnseenAnswer(item: MissionItemRecord): boolean {
    if (item.kind !== 'decision' || item.state !== 'answered') return false;
    const d = decisionOf(item);
    const at = d?.answer?.at;
    if (!d?.answer || !at) return false;
    if (d.delivery?.state === 'acked') return false;
    return !d.promptAckedAt || d.promptAckedAt < at;
}

function recommendedLabel(d: MissionDecision): string {
    if (!d.recommended) return '';
    const opt = d.options.find(o => o.id === d.recommended);
    return ` (rec ${d.recommended}${opt ? `: ${truncateMissionText(opt.label, LABEL_MAX)}` : ''})`;
}

function openDecisionLine(item: MissionItemRecord): string {
    const d = decisionOf(item);
    const q = truncateMissionText(d?.question || item.text, QUESTION_MAX);
    const urgent = d?.urgency === 'blocking' ? ' [blocking]' : '';
    return `  ? ${item.id}${urgent} ${q}${d ? recommendedLabel(d) : ''}`;
}

function answeredLine(item: MissionItemRecord): string {
    const d = decisionOf(item)!;
    const a = d.answer!;
    const opt = a.optionId ? d.options.find(o => o.id === a.optionId) : undefined;
    const answerText = [a.optionId ? `${a.optionId}${opt ? `: ${truncateMissionText(opt.label, LABEL_MAX)}` : ''}` : '', a.text ? truncateMissionText(a.text, 60) : '']
        .filter(Boolean).join(' / ') || '(no text)';
    return `  ✓ ${item.id} ${truncateMissionText(d.question || item.text, 50)} → ${answerText} (via ${a.via})`;
}

export interface MissionBlockInput {
    summary: MeshMissionSummary;
    open: { remaining: number; live_check: number; decision: number };
    openDecisions: MissionItemRecord[];
    answered: MissionItemRecord[];
    /** No summary and no items of any state → show the one-time migration hint. */
    needsMigration: boolean;
}

function countsLine(input: MissionBlockInput): string {
    const { remaining, live_check, decision } = input.open;
    const parts: string[] = [];
    if (remaining) parts.push(`${remaining} remaining`);
    if (live_check) parts.push(`${live_check} live_check`);
    if (decision) {
        const blocking = input.openDecisions.filter(i => decisionOf(i)?.urgency === 'blocking').length;
        parts.push(`${decision} decision${blocking ? ` (${blocking} blocking)` : ''}`);
    }
    return `  Open: ${parts.length ? parts.join(', ') : 'none'}`;
}

/**
 * One mission's block, deterministic and ≤ MISSION_BLOCK_CHAR_CAP chars. Required
 * lines (header, summary, open counts, tasks) are always kept; optional lines
 * (migration hint, answered decisions, open decisions — in that priority order,
 * blocking decisions first) are added while they fit, the rest collapse to "+N more".
 */
export function renderMissionBlock(input: MissionBlockInput): string {
    const m = input.summary;
    const carryOver = isCarryOverMissionRecord(m);
    const t = m.tasks;
    const header = `- **${truncateMissionText(m.title, TITLE_MAX)}** (id: \`${m.id}\`)${carryOver ? ' [carry-over]' : ''}`;
    const counts = countsLine(input);
    const tasks = carryOver || t.total === 0
        ? ''
        : `  Tasks: ${t.total} total — ${t.pending} pending (${t.blocked} blocked), ${t.assigned} assigned, ${t.completed} completed, ${t.failed} failed, ${t.cancelled} cancelled`;
    const summaryText = m.summary
        ? m.summary
        : (m.goal ? m.goal.replace(/\s+/g, ' ').trim() : '');
    const summaryLabel = m.summary ? 'Summary' : 'Goal';
    const fixed = header.length + counts.length + tasks.length + 3; // newlines
    // Optional lines need room: never let the summary starve them entirely, never exceed the cap.
    const summaryBudget = Math.max(40, Math.min(m.summary ? SUMMARY_MAX : GOAL_FALLBACK_MAX, MISSION_BLOCK_CHAR_CAP - fixed - 40));
    const summaryLine = summaryText ? `  ${summaryLabel}: ${truncateMissionText(summaryText, summaryBudget)}` : '';

    const required = [header, summaryLine, counts, tasks].filter(Boolean);
    let used = required.join('\n').length;

    const optional: string[] = [];
    if (input.needsMigration) optional.push(`  ${MISSION_MIGRATION_HINT}`);
    for (const a of input.answered) optional.push(answeredLine(a));
    const ordered = [...input.openDecisions].sort((a, b) => {
        const ba = decisionOf(a)?.urgency === 'blocking' ? 0 : 1;
        const bb = decisionOf(b)?.urgency === 'blocking' ? 0 : 1;
        return ba - bb; // stable: creation order within a tier
    });
    for (const d of ordered) optional.push(openDecisionLine(d));

    const lines = [...required];
    let omitted = 0;
    optional.forEach((line, idx) => {
        const remainingAfter = optional.length - idx - 1;
        // Keep room for the "+N more" line unless this is the last optional line.
        const reserve = remainingAfter > 0 ? MORE_LINE_RESERVE : 0;
        if (omitted === 0 && used + 1 + line.length + reserve <= MISSION_BLOCK_CHAR_CAP) {
            lines.push(line);
            used += 1 + line.length;
        } else {
            omitted += 1;
        }
    });
    if (omitted > 0) lines.push(`  +${omitted} more`);
    let out = lines.join('\n');
    // Final safety net (e.g. an enormous id): deterministic hard clamp.
    if (out.length > MISSION_BLOCK_CHAR_CAP) out = `${out.slice(0, MISSION_BLOCK_CHAR_CAP - 1)}…`;
    return out;
}

const SECTION_FOOTER =
    'Continue each mission from its current task state. Do not re-enqueue tasks that already exist — check mesh_view_queue first. '
    + 'Update a mission with mesh_mission_upsert (summary, items_add / items_update) when it changes or reaches a terminal state (completed/abandoned). '
    + 'Decision items are the OWNER\'s to answer — never answer one yourself; when an answer arrives act on it. '
    + 'Full goal text: mesh_mission_list verbose.';

/**
 * M3-3 / structured missions §7: render active missions as the {{mission}} prompt
 * section. Empty string when there is nothing to show (no active mission, or only an
 * empty carry-over mission) — the prompt stays byte-identical to the no-mission output.
 */
export function buildMissionPromptSection(meshId: string): string {
    const missions = getActiveMeshMissionSummaries(meshId);
    if (missions.length === 0) return '';
    const items = MeshRuntimeStore.getInstance().missionItems();
    const blocks: string[] = [];
    for (const mission of missions) {
        const carryOver = isCarryOverMissionRecord(mission);
        const all = items.listItems(meshId, mission.id);
        const open = all.filter(i => i.state === 'open');
        const openDecisions = open.filter(i => i.kind === 'decision');
        const counts = {
            remaining: open.filter(i => i.kind === 'remaining').length,
            live_check: open.filter(i => i.kind === 'live_check').length,
            decision: openDecisions.length,
        };
        // The carry-over mission appears only while it holds open items (it is otherwise noise).
        if (carryOver && counts.remaining + counts.live_check + counts.decision === 0) continue;
        blocks.push(renderMissionBlock({
            summary: mission,
            open: counts,
            openDecisions,
            answered: all.filter(isUnseenAnswer),
            needsMigration: !carryOver && !mission.summary && all.length === 0,
        }));
    }
    if (blocks.length === 0) return '';
    return [`## Active Mission${blocks.length > 1 ? 's' : ''}`, ...blocks, SECTION_FOOTER].join('\n');
}

/**
 * Advance the prompt watermark of one mission's answered decisions to `nowIso`. Idempotent:
 * already-seen answers are untouched. Returns how many items changed.
 */
export function acknowledgeAnsweredDecisions(meshId: string, missionId: string, nowIso: string = new Date().toISOString()): number {
    const items = MeshRuntimeStore.getInstance().missionItems();
    let n = 0;
    for (const item of items.listItems(meshId, missionId, { kinds: ['decision'], states: ['answered'] })) {
        if (!isUnseenAnswer(item) || !item.decision) continue;
        items.updateItem(meshId, item.id, { decision: { ...item.decision, promptAckedAt: nowIso } });
        n += 1;
    }
    return n;
}
