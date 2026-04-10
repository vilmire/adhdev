/**
 * DevServer — CDP & DOM Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 */
import type * as http from 'http';
import type { DevServerContext } from './dev-server-types.js';
export declare function handleCdpEvaluate(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleCdpClick(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleCdpDomQuery(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleScreenshot(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleScriptsRun(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleTypeAndSend(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleTypeAndSendAt(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleScriptHints(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleCdpTargets(ctx: DevServerContext, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleDomInspect(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleDomChildren(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleDomAnalyze(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleFindCommon(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleFindByText(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function handleDomContext(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
