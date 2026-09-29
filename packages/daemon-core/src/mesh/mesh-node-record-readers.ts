// Tolerant scalar readers over untyped node/status records, shared by the mesh-node
// identity, freshness, session and inline-cache modules (a leaf — no mesh imports).


export function readObjectRecord(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

export function readStringValue(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

export function readNumberValue(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return undefined;
}

export function readBooleanValue(...values: unknown[]): boolean | undefined {
    for (const value of values) {
        if (typeof value === 'boolean') return value;
    }
    return undefined;
}


export function toIsoTimestamp(value: unknown): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const stringValue = readStringValue(value);
    return stringValue || null;
}
