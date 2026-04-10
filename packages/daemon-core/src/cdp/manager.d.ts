/**
 * CDP Manager for ADHDev Daemon
 *
 * Ported cdp.ts from Extension for Daemon use.
 * vscode dependencies removed — works in pure Node.js environment.
 *
 * Connects to IDE CDP port (9222, 9333 etc) to:
 * - Execute JS via Runtime.evaluate
 * - Agent webview iframe search & session connection
 * - DOM query
 */
import type { CdpTargetFilter } from '../providers/contracts.js';
interface CdpTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}
export interface AgentWebviewTarget {
    targetId: string;
    extensionId: string;
    agentType: string;
    url: string;
}
export declare class DaemonCdpManager {
    private ws;
    private browserWs;
    private browserMsgId;
    private browserPending;
    private msgId;
    private pending;
    private port;
    private _connected;
    private _browserConnected;
    private targetUrl;
    private reconnectTimer;
    private contexts;
    private connectPromise;
    private failureCount;
    private readonly MAX_FAILURES;
    private agentSessions;
    private logFn;
    private extensionProviders;
    private _lastDiscoverSig;
    private _targetId;
    private _pageTitle;
    private _targetFilter;
    private _lastDiscoveredTargets?;
    constructor(port?: number, logFn?: (msg: string) => void, targetId?: string, targetFilter?: CdpTargetFilter);
    /** Set target filter (can be updated after construction) */
    setTargetFilter(filter: CdpTargetFilter): void;
    /** Clear a previously pinned target so the next connect can reselect a page. */
    clearTargetId(): void;
    /**
     * Check if a page title should be excluded (non-main page).
     * Uses provider-configured titleExcludes, falls back to default pattern.
     */
    private isNonMainTitle;
    /**
     * Check if a page URL matches the main window criteria.
     * Uses provider-configured urlIncludes/urlExcludes.
     */
    private isMainPageUrl;
    /** Connected page title (includes workspace name) */
    get pageTitle(): string;
    /** Connected target ID */
    get targetId(): string | null;
    /**
    * Query all workbench pages on port (static)
    * Returns multiple entries if multiple IDE windows are open on same port
    */
    static listAllTargets(port: number): Promise<CdpTarget[]>;
    setPort(port: number): void;
    getPort(): number;
    private log;
    connect(): Promise<boolean>;
    private doConnect;
    private findTargetOnPort;
    private findTarget;
    setExtensionProviders(providers: {
        agentType: string;
        extensionId: string;
        extensionIdPattern: RegExp;
    }[]): void;
    private connectToTarget;
    /** Browser-level CDP connection — needed for Target discovery */
    private connectBrowserWs;
    private getBrowserWsUrl;
    private sendBrowser;
    private scheduleReconnect;
    disconnect(): void;
    get isConnected(): boolean;
    private sendInternal;
    send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<any>;
    sendCdpCommand(method: string, params?: Record<string, unknown>): Promise<any>;
    evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
    querySelector(selector: string): Promise<string | null>;
    /**
    * Input text via CDP protocol then send Enter
    * Used for editors where execCommand does not work (e.g. Lexical).
    *
    * 1. Find editor by selector, focus + click
    * 2. Insert text via Input.insertText
    * 3. Send Enter via Input.dispatchKeyEvent
    */
    typeAndSend(selector: string, text: string): Promise<boolean>;
    /**
    * Coordinate-based typeAndSend — for input fields inside webview iframe
    * Receives coordinates directly instead of selector for click+input+Enter
    */
    typeAndSendAt(x: number, y: number, text: string): Promise<boolean>;
    /**
    * Evaluate JS from inside Webview iframe
    * Kiro, PearAI etc Used for IDEs where chat UI is inside webview iframe.
    *
    * 1. Query Target.getTargets via browser WS → find vscode-webview iframes
    * 2. Target.attachToTarget → session acquire
    * 3. Page.getFrameTree → nested iframe find
    * 4. Page.createIsolatedWorld → contextId acquire
    * 5. Runtime.evaluate → result return
    *
    * @param expression JS expression to execute
    * @param matchFn webview iframe URL match function (optional, all webview attempt)
    * @returns evaluate result or null
    */
    evaluateInWebviewFrame(expression: string, matchFn?: (bodyPreview: string) => boolean): Promise<string | null>;
    discoverAgentWebviews(): Promise<AgentWebviewTarget[]>;
    attachToAgent(target: AgentWebviewTarget): Promise<string | null>;
    evaluateInSession(sessionId: string, expression: string, timeoutMs?: number): Promise<unknown>;
    /**
     * Evaluate inside the child frame of an attached session.
     * Extension webviews have a nested iframe structure:
     *   outer (vscode-webview://) → inner (extension React app)
     * This method navigates into the inner frame using CDP Page.getFrameTree.
     * Falls back to evaluateInSession if no child frame is found.
     */
    evaluateInSessionFrame(sessionId: string, expression: string, timeoutMs?: number): Promise<unknown>;
    detachAgent(sessionId: string): Promise<void>;
    detachAllAgents(): Promise<void>;
    getAgentSessions(): Map<string, AgentWebviewTarget>;
    private getCurrentPageWebviewUrls;
    captureScreenshot(opts?: {
        quality?: number;
    }): Promise<Buffer | null>;
}
export {};
