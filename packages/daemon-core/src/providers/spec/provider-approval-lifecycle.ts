import { randomUUID } from 'node:crypto';
import type { ProviderApproval } from '@adhdev/mesh-shared';
import type { AdapterStatusInputs } from './adapter-status-projection.js';

/** Content-free identity survives repaint, but never a resolution or new episode. */
export class ProviderApprovalLifecycle {
    private current: ProviderApproval | null = null;
    private signature: string | null = null;
    private inApproval = false;

    observe(state: AdapterStatusInputs['state'], modal: AdapterStatusInputs['modal'], at: number | null, directories?: { runtimeDirectory: string; displayedDirectory: string | null }, assignment?: Partial<ProviderApproval>): void {
        const waiting = state?.status === 'approval';
        if (!waiting) {
            this.resolve(at ?? Date.now());
            this.inApproval = false;
            this.signature = null;
            return;
        }
        const setup = /trust|workspace_confirm|directory_confirm/i.test(state.id);
        const confirmed = !!modal?.buttons.length && (modal.kind === 'approval' || setup);
        // A transient empty repaint removes actionability without replacing the identity.
        if (!confirmed) {
            if (this.current?.lifecycle === 'pending') this.current = { ...this.current, evidence: 'unavailable', actionable: false };
            else this.current = {
                source: 'provider_modal', type: setup ? 'provider_setup' : 'unknown', evidence: 'unavailable',
                lifecycle: 'pending', modalKey: null, createdAt: null, resolvedAt: null,
                description: '', buttons: [], actionable: false,
            };
            this.inApproval = true;
            return;
        }
        const titleHead = typeof modal.title === 'string'
            ? (modal.title.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '')
            : '';
        const signature = JSON.stringify([state.id, modal.kind, titleHead, modal.buttons]);
        const isNew = !this.inApproval || !this.current?.modalKey || signature !== this.signature;
        if (isNew) {
            this.current = {
                ...assignment,
                source: 'provider_modal', type: setup ? 'provider_setup' : 'tool_permission', evidence: 'live',
                lifecycle: 'pending', modalKey: `modal:${randomUUID()}`, createdAt: at, resolvedAt: null,
                // Extracted titles can be button lines or private prompt text. The Inbox
                // uses localized type descriptions; the full modal stays session-scoped.
                ...(setup && directories ? directories : {}),
                description: '', buttons: modal.buttons.map(b => b.label.slice(0, 120)), actionable: !setup,
            };
        } else if (this.current?.lifecycle === 'pending') {
            this.current = { ...this.current, evidence: 'live', actionable: !setup };
        }
        this.signature = signature;
        this.inApproval = true;
    }

    resolve(at: number): void {
        if (this.current?.lifecycle === 'pending') this.current = { ...this.current, lifecycle: 'resolved', actionable: false, resolvedAt: at };
    }

    read(): ProviderApproval | null { return this.current ? { ...this.current, buttons: [...this.current.buttons] } : null; }
}

/** Read only the directory line immediately following the provider's trust question. */
export function readDisplayedTrustDirectory(screen: string): string | null {
    const lines = screen.split(/\r?\n/);
    const question = lines.findIndex(line => /Do you trust the contents of this directory\?/i.test(line));
    if (question < 0) return null;
    const candidate = lines.slice(question + 1, question + 5).map(line => line.trim()).find(line => /^(?:\/|[A-Za-z]:[\\/])/.test(line));
    return candidate && candidate.length <= 512 && !/[\x00-\x1f]/.test(candidate) ? candidate : null;
}

/** Dispatch settings are authority; modal text can never supply assignment identity. */
export function providerApprovalAssignment(settings: Record<string, unknown>): Pick<ProviderApproval, 'nodeId' | 'meshId' | 'taskId' | 'attemptId' | 'generation'> {
    const string = (key: string): string | null => typeof settings[key] === 'string' && settings[key] ? settings[key] as string : null;
    const attemptId = string('meshActiveAttemptId');
    const rawGeneration = settings.meshActiveAttemptGeneration;
    const generation = attemptId && typeof rawGeneration === 'number' && Number.isInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : null;
    return { nodeId: string('meshNodeId'), meshId: string('meshNodeFor'), taskId: string('meshActiveTaskId'), attemptId, generation };
}

export function bindProviderApprovalAssignment(approval: ProviderApproval | null | undefined, settings: Record<string, unknown>): ProviderApproval | null {
    if (!approval) return null;
    const identity = providerApprovalAssignment(settings);
    const changed = approval.type === 'tool_permission' && approval.attemptId && (approval.attemptId !== identity.attemptId || approval.generation !== identity.generation);
    if (changed) return { ...approval, actionable: false, evidence: 'unavailable' };
    return { ...approval, ...identity, actionable: approval.actionable && (!identity.taskId || (!!identity.attemptId && identity.generation !== null)) };
}
