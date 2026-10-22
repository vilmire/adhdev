/** A complete host inventory is authoritative only for bindings owned here. */
export interface HostedBindingOwner {
    endpoint: string;
    managedBy: string;
    clientId: string;
}

export function readHostedBindingOwner(raw: unknown): HostedBindingOwner | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (![r.endpoint, r.managedBy, r.clientId].every(v => typeof v === 'string' && v.trim())) return undefined;
    return { endpoint: r.endpoint as string, managedBy: r.managedBy as string, clientId: r.clientId as string };
}

export function sameHostedBindingOwner(a: unknown, b: unknown): boolean {
    const left = readHostedBindingOwner(a), right = readHostedBindingOwner(b);
    return !!left && !!right && left.endpoint === right.endpoint
        && left.managedBy === right.managedBy && left.clientId === right.clientId;
}
