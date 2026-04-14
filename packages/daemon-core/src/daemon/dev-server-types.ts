/**
 * Shared types & context interface for DevServer handler modules.
 *
 * Each handler module (cdp, cli-debug, auto-implement) imports DevServerContext
 * to access shared state and utilities without circular references.
 */
import type * as http from 'http';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { DaemonCliManager } from '../commands/cli-manager.js';
import type { ProviderCategory } from '../providers/contracts.js';

/**
 * Context passed from the main DevServer to handler modules.
 * Provides access to shared dependencies and utility methods.
 */
export interface DevServerContext {
  readonly providerLoader: ProviderLoader;
  readonly cdpManagers: Map<string, DaemonCdpManager>;
  readonly instanceManager: ProviderInstanceManager | null;
  readonly cliManager: DaemonCliManager | null;
  readonly onProviderSourceConfigChanged?: (() => Promise<void> | void) | null;

  // Utilities
  getCdp(ideType?: string): DaemonCdpManager | null;
  json(res: http.ServerResponse, status: number, data: any): void;
  readBody(req: http.IncomingMessage): Promise<any>;
  log(msg: string): void;

  // SSE utilities
  autoImplSSEClients: http.ServerResponse[];
    sendAutoImplSSE(msg: { event: string; data: any }): void;
  autoImplStatus: { running: boolean; type: string | null; progress: any[] };
  autoImplProcess: import('child_process').ChildProcess | null;

  // CLI SSE
  sendCliSSE(data: any): void;

  // Provider directory resolution
  handleRunScript(type: string, req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: any): Promise<void>;
  findProviderDir(type: string): string | null;
  getLatestScriptVersionDir(scriptsDir: string): string | null;
}

/** Re-export for convenience */
export type { ProviderCategory };
