export function requiresRetirementProof(repo: string, ref?: string, base?: string): boolean;
export function validateRetirementProof(repo: string, layer: 'root' | 'oss', options?: { ref?: string; env?: NodeJS.ProcessEnv; proofFile?: string }): unknown;
