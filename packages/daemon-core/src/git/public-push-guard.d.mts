export function loadPublicPushPatternsForRepo(repo: string, privateRoot?: string): Promise<PublicPushPatterns>;
export interface PublicPushPatterns { ownerNames: string[]; knownHosts: string[]; blockedText: string[]; repositories?: Record<string, 'public' | 'private'> }
export function loadPublicPushPatterns(repo: string, options?: { forRepo?: string; expectedDigest?: string }): PublicPushPatterns;
export function parseRemoteUrl(url: string): { protocol: string; host: string; port: string; path: string } | null;
export const REQUIRED_NAME: string;
export const REQUIRED_EMAIL: string;
export const BLOCKED_HINT: string;
export interface PushEntry { localRef?: string; localSha: string; remoteRef?: string; remoteSha?: string }
export interface PushViolation { kind: 'identity' | 'path' | 'source_phase'; sha: string; ref?: string; detail: string; file?: string; line?: number }
export function isPublicRemoteUrl(url: string): boolean;
export function pushDestinations(cwd: string, remoteName?: string): Promise<{ urls: string[]; configuredUrls: string[]; isPublic: boolean }>;
export function newCommits(cwd: string, remoteName: string, localSha: string, remoteSha?: string, provenCommits?: string[]): Promise<string[]>;
export function parseDiffTree(text: string, scan: (t: string) => Array<{ line: number; match: string; name?: string }>): PushViolation[];
export function checkPush(entries: PushEntry[], opts?: { cwd?: string; remoteName?: string; remoteUrl?: string; integrationBase?: string; ownerNames?: Iterable<string>; patterns?: PublicPushPatterns; findLeaksFn?: (t: string) => Array<{ line: number; match: string; name?: string }> }): Promise<{ violations: PushViolation[]; checked: number }>;
export function formatViolation(v: PushViolation): string;
export function assertPublishableToPublicOss(cwd: string, commit: string, opts?: { remoteName?: string; remoteUrl?: string; remoteRef?: string; integrationBase?: string; patterns?: PublicPushPatterns }): Promise<{ checked: number }>;
export function createDiffTreeParser(scan: (t: string) => Array<{ line: number; match: string; name?: string }>): { feed(chunk: string): void; end(): PushViolation[] };

export function publicPushPendingCommits(cwd: string, commit: string, remoteRef: string, urls: string[], expectedBase?: string): Promise<string[]>;

export function publicPushRepoKey(cwd: string, remoteName?: string): Promise<string>;

export function publicPushRepoKeys(cwd: string, remoteName?: string): Promise<Array<{ url: string; repoKey: string }>>;

export function readPushIntegrationBase(cwd: string, destination: string, remoteRef: string): Promise<string>;

export class PublishDestinationError extends Error { code: string; }
export function canonicalPushIdentity(url: string): string;
export function resolvePushPolicy(cwd: string, remoteName?: string): Promise<{ urls: string[]; isPublic: boolean; keyed: Array<{ url: string; repoKey: string; visibility: string }> }>;
