import type { DevServerContext } from './dev-server-types.js';
/**
 * Dev Server — HTTP API for Provider debugging + script development
 *
 * Enabled with `adhdev daemon --dev`
 * Port: 19280 (fixed)
 *
 * API list:
 * GET /api/providers — loaded provider list
 * POST /api/providers/:type/script — specific script execute
 * POST /api/cdp/evaluate — Execute JS expression
 * POST /api/cdp/dom/query — Test selector
 * GET /api/cdp/screenshot — screenshot
 * POST /api/scripts/run — Execute provider script (name + params)
 * GET /api/status — All status (CDP connection, provider etc)
 */
import * as http from 'http';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ChildProcess } from 'child_process';
import type { DaemonCdpManager } from '../cdp/manager.js';
import type { ProviderInstanceManager } from '../providers/provider-instance-manager.js';
import type { DaemonCliManager } from '../commands/cli-manager.js';
export declare const DEV_SERVER_PORT = 19280;
export declare class DevServer implements DevServerContext {
    private server;
    providerLoader: ProviderLoader;
    cdpManagers: Map<string, DaemonCdpManager>;
    instanceManager: ProviderInstanceManager | null;
    cliManager: DaemonCliManager | null;
    private logFn;
    private sseClients;
    private watchScriptPath;
    private watchScriptName;
    private watchTimer;
    autoImplProcess: ChildProcess | null;
    autoImplSSEClients: http.ServerResponse[];
    autoImplStatus: {
        running: boolean;
        type: string | null;
        progress: any[];
    };
    private cliSSEClients;
    constructor(options: {
        providerLoader: ProviderLoader;
        cdpManagers: Map<string, DaemonCdpManager>;
        instanceManager?: ProviderInstanceManager;
        cliManager?: DaemonCliManager;
        logFn?: (msg: string) => void;
    });
    log(msg: string): void;
    private readonly routes;
    private matchRoute;
    private getEndpointList;
    start(port?: number): Promise<void>;
    stop(): void;
    private handleListProviders;
    private handleProviderConfig;
    private handleSpawnTest;
    handleRunScript(type: string, req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: any): Promise<void>;
    private handleCdpEvaluate;
    private handleCdpClick;
    private handleCdpDomQuery;
    private handleScreenshot;
    private handleScriptsRun;
    private handleStatus;
    private handleReload;
    private getConsoleDistDir;
    private serveConsole;
    private static MIME_MAP;
    private serveStaticAsset;
    private handleSSE;
    private sendSSE;
    private handleWatchStart;
    private handleWatchStop;
    /** Find the provider directory on disk */
    findProviderDir(type: string): string | null;
    /** GET /api/providers/:type/files — list all files in provider directory */
    private handleListFiles;
    /** GET /api/providers/:type/file?path=scripts.js — read a file */
    private handleReadFile;
    /** POST /api/providers/:type/file — write a file { path, content } */
    private handleWriteFile;
    private handleSource;
    private handleSave;
    private handleTypeAndSend;
    private handleTypeAndSendAt;
    private handleScriptHints;
    private handleValidate;
    private handleAcpChat;
    private handleCdpTargets;
    private handleScaffold;
    private handleDetectVersions;
    private handleDomInspect;
    private handleDomChildren;
    private handleDomAnalyze;
    private handleFindCommon;
    private handleFindByText;
    private handleDomContext;
    getLatestScriptVersionDir(scriptsDir: string): string | null;
    private resolveAutoImplWritableProviderDir;
    private handleAutoImplement;
    private buildAutoImplPrompt;
    private buildCliAutoImplPrompt;
    private handleAutoImplSSE;
    private handleAutoImplCancel;
    sendAutoImplSSE(msg: {
        event: string;
        data: any;
    }): void;
    /** Get CDP manager — matching IDE when ideType specified, first connected one otherwise.
     *  DevServer is a debugging tool so first-connected fallback is acceptable,
     *  but callers should pass ideType when possible. */
    getCdp(ideType?: string): DaemonCdpManager | null;
    json(res: http.ServerResponse, status: number, data: any): void;
    readBody(req: http.IncomingMessage): Promise<any>;
    /** GET /api/cli/status — list all running CLI/ACP instances with state */
    private handleCliStatus;
    /** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
    private handleCliLaunch;
    /** POST /api/cli/send — send message to a running CLI { type, text } */
    private handleCliSend;
    /** POST /api/cli/exercise — launch/send/approve/wait helper for provider-fix loops */
    private handleCliExercise;
    private handleCliFixtureCapture;
    private handleCliFixtureReplay;
    /** POST /api/cli/stop — stop a running CLI { type } */
    private handleCliStop;
    /** GET /api/cli/events — SSE stream of CLI status events */
    private handleCliSSE;
    sendCliSSE(data: any): void;
    /** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
    private handleCliDebug;
    /** GET /api/cli/trace/:type — recent CLI trace timeline plus current debug snapshot */
    private handleCliTrace;
    private handleCliFixtureList;
    /** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
    private handleCliResolve;
    /** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
    private handleCliRaw;
}
