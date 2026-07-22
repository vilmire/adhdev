/**
 * agent:waiting_choice event registration (mission f1d25e11).
 *
 * A worker parked on an AskUserQuestion multi-choice prompt emits agent:waiting_choice —
 * a DISTINCT event from agent:waiting_approval. It must be:
 *   - a recognised coordinator event (so it is routed to the coordinator),
 *   - force-injected (real-time, may arrive while the coordinator is generating),
 *   - treated as an approval-class (level-backed, nudge-only) event, and
 *   - mapped to the task_question_pending ledger kind — NOT task_approval_needed, so it
 *     stays out of the mesh_approve / approval-inbox flow.
 */

import { describe, expect, it } from 'vitest';
import {
  isMeshCoordinatorEvent,
  shouldForceInjectMeshEvent,
  isMeshApprovalEvent,
  EVENT_TO_LEDGER_KIND,
} from '../../src/mesh/mesh-event-classify.js';
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js';

describe('agent:waiting_choice classification (mission f1d25e11)', () => {
  it('is a coordinator event', () => {
    expect(isMeshCoordinatorEvent('agent:waiting_choice')).toBe(true);
  });

  it('is force-injected (real-time nudge to a possibly-busy coordinator)', () => {
    expect(shouldForceInjectMeshEvent('agent:waiting_choice')).toBe(true);
  });

  it('is treated as an approval-class (level-backed nudge) event', () => {
    expect(isMeshApprovalEvent('agent:waiting_choice')).toBe(true);
  });

  it('maps to task_question_pending, NOT task_approval_needed', () => {
    expect(EVENT_TO_LEDGER_KIND['agent:waiting_choice']).toBe('task_question_pending');
    // The approval event keeps its own distinct kind — the two never collapse.
    expect(EVENT_TO_LEDGER_KIND['agent:waiting_approval']).toBe('task_approval_needed');
  });

  it('the coordinator inbox message renders the question + options and points to mesh_answer_question (not mesh_approve)', () => {
    const message = buildMeshSystemMessage({
      event: 'agent:waiting_choice',
      nodeLabel: 'node_worker',
      metadataEvent: {
        promptId: 'ask-1',
        interactivePrompt: {
          promptId: 'ask-1',
          questions: [
            {
              questionId: 'scope',
              header: 'Scope',
              question: 'Which scope?',
              multiSelect: false,
              options: [
                { label: 'unicast', description: 'one target' },
                { label: 'broadcast' },
              ],
            },
          ],
        },
      },
    });
    expect(message).toContain('is asking a question');
    expect(message).toContain('Which scope?');
    expect(message).toContain('1. unicast');
    expect(message).toContain('one target');
    expect(message).toContain('2. broadcast');
    expect(message).toContain('mesh_answer_question');
    expect(message).toContain('ask-1');
    // Must steer AWAY from mesh_approve for a question.
    expect(message).toMatch(/Do NOT use mesh_approve/i);
  });
});
