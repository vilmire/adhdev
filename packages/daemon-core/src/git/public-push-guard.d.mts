export const REQUIRED_NAME: string;
export const REQUIRED_EMAIL: string;
export const BLOCKED_HINT: string;
export interface PushEntry { localRef?: string; localSha: string; remoteRef?: string; remoteSha?: string }
export interface PushViolation { kind: 'identity' | 'path'; sha: string; ref?: string; detail: string; file?: string; line?: number }
export function isPublicRemoteUrl(url: string): boolean;
export function newCommits(cwd: string, remoteName: string, localSha: string, remoteSha?: string): Promise<string[]>;
export function parseDiffTree(text: string, scan: (t: string) => Array<{ line: number; match: string; name?: string }>): PushViolation[];
export function checkPush(entries: PushEntry[], opts?: { cwd?: string; remoteName?: string; findLeaksFn?: (t: string) => Array<{ line: number; match: string; name?: string }> }): Promise<{ violations: PushViolation[]; checked: number }>;
export function formatViolation(v: PushViolation): string;
export function assertPublishableToPublicOss(cwd: string, commit: string, opts?: { remoteName?: string }): Promise<{ checked: number }>;
