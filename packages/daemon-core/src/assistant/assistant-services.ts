/**
 * The daemon's assistant store instances — one per daemon, built lazily from
 * the daemon config dir on first use, replaceable for tests.
 *
 * The store verbs (commands/high-family/assistant-store.ts) are the only
 * consumers today; the relay / launch units will reach the same instances
 * (notably the input log, which the relay appends to).
 */

import { getConfigDir } from '../config/config.js';
import { AssistantMemoryStore } from './memory/memory-store.js';
import { AssistantSkillStore } from './skills/skill-store.js';
import { defaultHermesHome } from './skills/hermes-import.js';
import { AssistantNoteStaging } from './note-staging.js';
import { AssistantInputLog } from './assistant-input-log.js';
import { listMeshesReadOnly } from '../config/mesh-config.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import type { RecordOperatingNoteInput, OperatingNoteEntry } from '../mesh/mesh-operating-notes.js';

/** The two existing operating-note entry points `project_note` calls (§4.10.3). */
export interface AssistantOperatingNotesPort {
    record(meshId: string, input: RecordOperatingNoteInput): Promise<OperatingNoteEntry>;
    forget(meshId: string, target: { noteId?: string; text?: string; reason?: string }): Promise<{ matched: number }>;
}

/**
 * M7 (design §1, research 2026-10-08 Q7): a review turn counts as productive
 * only when one of its writes is APPLIED (clean review) or APPROVED by the
 * owner (staged, then resolved with apply). The assistant runtime installs the
 * sink when it has the metrics table; tests and a runtime without it leave
 * it unset.
 */
export interface AssistantReviewMetricsPort {
    creditReviewWrite(reviewTurnId: string, kind: 'applied' | 'approved', at: number): void;
}

export interface AssistantServices {
    memory: AssistantMemoryStore;
    skills: AssistantSkillStore;
    notes: AssistantNoteStaging;
    inputLog: AssistantInputLog;
    operatingNotes: AssistantOperatingNotesPort;
    hermesHome: string;
    /** Project inventory (§4.2): this daemon's meshes.json. */
    listMeshes: () => LocalMeshEntry[];
    /**
     * Whether this daemon hosts the mesh (§4.2 eligibility). Unset → the verb
     * asks the live daemon components (`hostedMeshes`). Tests inject it.
     */
    isMeshHostedHere?: (mesh: LocalMeshEntry) => boolean;
    /** M7 sink, installed by the assistant runtime (`wireAssistantRuntime`). */
    reviewMetrics?: AssistantReviewMetricsPort | null;
}

const defaultOperatingNotes: AssistantOperatingNotesPort = {
    async record(meshId, input) {
        const { recordOperatingNote } = await import('../mesh/mesh-operating-notes.js');
        return recordOperatingNote(meshId, input);
    },
    async forget(meshId, target) {
        const { forgetOperatingNote } = await import('../mesh/mesh-operating-notes.js');
        return forgetOperatingNote(meshId, target);
    },
};

let current: AssistantServices | null = null;

export interface CreateAssistantServicesOptions {
    configDir?: string;
    now?: () => Date;
    hermesHome?: string;
    operatingNotes?: AssistantOperatingNotesPort;
    listMeshes?: () => LocalMeshEntry[];
    isMeshHostedHere?: (mesh: LocalMeshEntry) => boolean;
}

export function createAssistantServices(opts: CreateAssistantServicesOptions = {}): AssistantServices {
    const configDir = opts.configDir ?? getConfigDir();
    return {
        memory: new AssistantMemoryStore({ configDir, now: opts.now }),
        skills: new AssistantSkillStore({ configDir, now: opts.now }),
        notes: new AssistantNoteStaging({ configDir, now: opts.now }),
        inputLog: new AssistantInputLog(),
        operatingNotes: opts.operatingNotes ?? defaultOperatingNotes,
        hermesHome: opts.hermesHome ?? defaultHermesHome(),
        listMeshes: opts.listMeshes ?? listMeshesReadOnly,
        ...(opts.isMeshHostedHere ? { isMeshHostedHere: opts.isMeshHostedHere } : {}),
    };
}

export function getAssistantServices(): AssistantServices {
    if (!current) current = createAssistantServices();
    return current;
}

/** Tests: install a fixture set (null → rebuild lazily from the config dir next time). */
export function setAssistantServicesForTests(services: AssistantServices | null): void {
    current = services;
}
