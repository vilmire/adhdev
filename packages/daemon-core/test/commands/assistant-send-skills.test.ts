/**
 * project_send × procedure skills (design 2026-11-01-procedure-skills.md §3,
 * §5.1, §6, acceptance 9): attach counts as use, skillHints only when no
 * skills were named, hint acceptance, recurring-request signals only for
 * human-started turns, and no skill / signal data on the status path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_VERB } from '@adhdev/mesh-shared';
import { assistantProjectHandlers } from '../../src/commands/high-family/assistant.js';
import { createAssistantServices, setAssistantServicesForTests, type AssistantServices } from '../../src/assistant/assistant-services.js';
import { setAssistantProjectPortsForTests, type AssistantProjectPorts } from '../../src/assistant/assistant-project-ports.js';
import { resetSkillHintTracker } from '../../src/assistant/skills/skill-hints.js';
import { ProcedureSignalStore } from '../../src/assistant/procedure-signal-store.js';
import { ensureAssistantRelaySchema } from '../../src/mesh/mesh-runtime-store-schema.js';
import { ensureProcedureSignalSchema } from '../../src/mesh/procedure-signal-schema.js';
import { STARTER_SKILLS } from '../../src/assistant/skills/starter-skills.js';
import type { LocalMeshEntry } from '../../src/repo-mesh-types.js';

const SELF = 'daemon_mach_self';
const SID = 'a1';
let dir: string;
let svc: AssistantServices;
let db: Database.Database;
let signals: ProcedureSignalStore;
let metrics: Array<[string, string, number]>;
const recordSkillAttaches = vi.fn();
const run = (args: Record<string, unknown>) => assistantProjectHandlers[ASSISTANT_VERB.projectSend]({} as any, { project: 'adhdev', assistantSessionId: SID, ...args });
const REQ = 'Deploy the preview build, verify it on the dashboard, then update the changelog entry';

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adhdev-send-skills-'));
    const meshes = [{ id: 'mesh_a', name: 'ADHDev', repoIdentity: 'github.com/vilmire/adhdev', nodes: [{ id: 'n1', workspace: '/w/adhdev', daemonId: SELF }] } as unknown as LocalMeshEntry];
    const ports = {
        selfDaemonId: () => SELF,
        listMeshes: () => meshes,
        isHostedHere: () => true,
        aliases: () => ({}),
        coordinators: () => [{ sessionId: 'c1', idle: true, modalParked: false, managedByAssistant: true }],
        lastCoordinatorSessionId: () => 'c1',
        queueCounts: () => ({ pending: 0, assigned: 0, failed: 0 }),
        activeMissionCount: () => 0,
        pendingApprovals: () => 0,
        relay: { assistantSessionId: () => SID, recordProjectRead: vi.fn(), openThread: vi.fn(), recordSkillAttaches, isThreadOpen: () => true, lastRelayAt: () => 0 },
        execute: vi.fn(async () => ({ success: true })),
        remoteHost: () => ({ label: 'x', hostDaemonId: null, hostMeshId: 'x', reachable: false }),
        callHost: vi.fn(),
        coordinatorTurns: () => ({ open: false, committed: [] }),
        meshStatusLine: () => null,
        routePreview: async () => null,
        liveSessionStates: () => [],
    } as unknown as AssistantProjectPorts;
    setAssistantProjectPortsForTests(() => ports);
    svc = createAssistantServices({ configDir: dir, listMeshes: () => meshes, isMeshHostedHere: () => true });
    db = new Database(':memory:');
    ensureAssistantRelaySchema(db);
    ensureProcedureSignalSchema(db);
    signals = new ProcedureSignalStore(db);
    metrics = [];
    svc.skillMetrics = { bump: (c, m, at) => void metrics.push([c, m, at]) };
    svc.procedureSignals = signals;
    for (const d of STARTER_SKILLS) svc.skills.manage({ action: 'create', ...d }, 'owner', null);
    setAssistantServicesForTests(svc);
    resetSkillHintTracker();
    recordSkillAttaches.mockReset();
    svc.inputLog.begin(SID);
    svc.inputLog.append(SID, 'human');
});
afterEach(() => {
    setAssistantProjectPortsForTests(null);
    setAssistantServicesForTests(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

const metricCount = (c: string) => metrics.filter((m) => m[0] === c).length;
const skill = (name: string) => svc.skills.list().find((s) => s.name === name)!;

describe('use counts', () => {
    it('attaching a skill counts attachCount (not viewCount) and keeps the attach size limit', async () => {
        const r: any = await run({ message: 'ship it', skills: ['deploy-verify-checklist'], messageId: 'm1' });
        expect(r.success).toBe(true);
        expect(r.result.attachedSkills).toEqual(['deploy-verify-checklist']);
        expect(skill('deploy-verify-checklist')).toMatchObject({ attachCount: 1, viewCount: 0 });
        expect(recordSkillAttaches).toHaveBeenCalledWith('mesh_a', 1);
        expect(await run({ message: 'ship it', skills: ['deploy-verify-checklist', 'branch-convergence-report', 'mesh-dispatch-hygiene'] })).toMatchObject({ success: false, code: 'invalid_args' });
    });

    it('a failed send counts nothing', async () => {
        expect(await run({ message: 'x', skills: ['nope'] })).toMatchObject({ success: false, code: 'skill_not_found' });
        expect(skill('deploy-verify-checklist').attachCount).toBe(0);
    });
});

describe('skillHints', () => {
    it('a send naming no skills gets hints when a skill fits; they are counted, nothing is attached', async () => {
        const r: any = await run({ message: 'deploy a change and verify it before release', messageId: 'h1' });
        expect(r.result.skillHints[0]).toMatchObject({ name: 'deploy-verify-checklist' });
        expect(r.result.skillHintNote).toMatch(/skills:\["name"\]/);
        expect(r.result.attachedSkills).toBeUndefined();
        expect(skill('deploy-verify-checklist')).toMatchObject({ attachCount: 0, hintShownCount: 1 });
        expect(metricCount('skill_hints')).toBe(1);
    });

    it('no hints when skills were named, or nothing fits', async () => {
        const named: any = await run({ message: 'deploy a change and verify it before release', skills: ['mesh-dispatch-hygiene'] });
        expect(named.result.skillHints).toBeUndefined();
        const none: any = await run({ message: 'fix the rss feed', messageId: 'h2' });
        expect(none.result.skillHints).toBeUndefined();
    });

    it('attaching the hinted skill on the next send counts a hint accept once', async () => {
        await run({ message: 'deploy a change and verify it before release', messageId: 'h1' });
        await run({ message: 'deploy a change and verify it before release', skills: ['deploy-verify-checklist'], messageId: 'h2' });
        expect(skill('deploy-verify-checklist')).toMatchObject({ hintAcceptCount: 1, attachCount: 1 });
        expect(metricCount('skill_hint_accepts')).toBe(1);
        await run({ message: 'again', skills: ['deploy-verify-checklist'], messageId: 'h3' });
        expect(skill('deploy-verify-checklist').hintAcceptCount).toBe(1);
    });
});

describe('recurring-request signals from project_send', () => {
    it('records a signal for a send in a human-started turn', async () => {
        await run({ message: REQ, messageId: 's1' });
        expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_procedure_signals').get() as { n: number }).n).toBe(1);
    });

    it('does not record when a relay started the turn (tainted)', async () => {
        svc.inputLog.closeTurn(SID);
        svc.inputLog.append(SID, 'relay');
        await run({ message: REQ, messageId: 's2' });
        expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_procedure_signals').get() as { n: number }).n).toBe(0);
    });

    it('does not record without an assistant session (fail-closed origin)', async () => {
        await run({ message: REQ, messageId: 's3', assistantSessionId: 'someone-else' });
        expect((db.prepare('SELECT COUNT(*) AS n FROM assistant_procedure_signals').get() as { n: number }).n).toBe(0);
    });
});
