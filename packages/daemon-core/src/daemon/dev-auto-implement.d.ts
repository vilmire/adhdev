/**
 * DevServer — Auto-Implement Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 * Contains prompt builders (IDE + CLI), agent spawn logic,
 * SSE streaming, and provider directory resolution for auto-implement.
 */
import type * as http from 'http';
import type { DevServerContext, ProviderCategory } from './dev-server-types.js';
type CliExerciseVerification = {
    request?: Record<string, any>;
    mustContainAny?: string[];
    mustNotContainAny?: string[];
    mustMatchAny?: string[];
    mustNotMatchAny?: string[];
    lastAssistantMustContainAny?: string[];
    lastAssistantMustNotContainAny?: string[];
    lastAssistantMustMatchAny?: string[];
    lastAssistantMustNotMatchAny?: string[];
    inspectFields?: string[];
    description?: string;
    focusAreas?: string[];
    fixtureName?: string;
    fixtureNames?: string[];
};
export declare function getDefaultAutoImplReference(ctx: DevServerContext, category: string, type: string): string;
export declare function resolveAutoImplReference(ctx: DevServerContext, category: string, requestedReference: string | undefined, targetType: string): string | null;
export declare function getLatestScriptVersionDir(scriptsDir: string): string | null;
export declare function resolveAutoImplWritableProviderDir(ctx: DevServerContext, category: ProviderCategory, type: string, requestedDir?: string): {
    dir: string | null;
    reason?: string;
};
export declare function loadAutoImplReferenceScripts(ctx: DevServerContext, referenceType: string | null): Record<string, string>;
export declare function handleAutoImplement(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export declare function buildAutoImplPrompt(ctx: DevServerContext, type: string, provider: any, providerDir: string, functions: string[], domContext: any, referenceScripts: Record<string, string>, userComment?: string, referenceType?: string | null, verification?: CliExerciseVerification): string;
export declare function buildCliAutoImplPrompt(ctx: DevServerContext, type: string, provider: any, providerDir: string, functions: string[], referenceScripts: Record<string, string>, userComment?: string, referenceType?: string | null, verification?: CliExerciseVerification): string;
export declare function handleAutoImplSSE(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): void;
export declare function handleAutoImplCancel(ctx: DevServerContext, _type: string, _req: http.IncomingMessage, res: http.ServerResponse): void;
export declare function sendAutoImplSSE(ctx: DevServerContext, msg: {
    event: string;
    data: any;
}): void;
export {};
