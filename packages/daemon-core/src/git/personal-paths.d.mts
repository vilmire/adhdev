export interface Leak { line: number; match: string; name: string }
export function findLeaks(text: string, extraNames?: Set<string>, runtimeHosts?: string[], knownHosts?: string[]): Leak[];
export function currentUserNames(): Set<string>;
