/**
 * Recent workspace activity — quick "pick up where you left off" (daemon-local).
 */
import type { ADHDevConfig } from './config.js';
export interface WorkspaceActivityEntry {
    path: string;
    lastUsedAt: number;
    /** `active` legacy — same meaning as default */
    kind?: 'ide' | 'cli' | 'acp' | 'default' | 'active';
    /** IDE id or CLI/ACP provider type */
    agentType?: string;
}
export declare function normWorkspacePath(p: string): string;
/**
 * Append or bump a path to the front of recent activity (returns new config object).
 */
export declare function appendWorkspaceActivity(config: ADHDevConfig, rawPath: string, meta?: {
    kind?: WorkspaceActivityEntry['kind'];
    agentType?: string;
}): ADHDevConfig;
export declare function getWorkspaceActivity(config: ADHDevConfig, limit?: number): WorkspaceActivityEntry[];
export declare function removeActivityForPath(config: ADHDevConfig, rawPath: string): ADHDevConfig;
