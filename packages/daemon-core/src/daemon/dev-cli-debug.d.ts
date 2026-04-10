/**
 * DevServer — CLI Debug Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 * All functions take a DevServerContext as their first argument.
 */
import type * as http from 'http';
import type { DevServerContext } from './dev-server-types.js';
type CliExerciseRequest = {
    type?: string;
    text?: string;
    instanceId?: string;
    workingDir?: string;
    args?: string[];
    autoLaunch?: boolean;
    freshSession?: boolean;
    autoResolveApprovals?: boolean;
    approvalButtonIndex?: number;
    timeoutMs?: number;
    readyTimeoutMs?: number;
    idleSettledMs?: number;
    traceLimit?: number;
    stopWhenDone?: boolean;
};
export type CliFixtureAssertions = {
    mustContainAny?: string[];
    mustNotContainAny?: string[];
    mustMatchAny?: string[];
    mustNotMatchAny?: string[];
    lastAssistantMustContainAny?: string[];
    lastAssistantMustNotContainAny?: string[];
    lastAssistantMustMatchAny?: string[];
    lastAssistantMustNotMatchAny?: string[];
    statusesSeen?: string[];
    requireNotTimedOut?: boolean;
};
type CliExerciseFixture = {
    version: 1;
    kind: 'cli-exercise-fixture';
    name: string;
    type: string;
    createdAt: string;
    providerDir: string | null;
    providerResolution: Record<string, any> | null;
    request: CliExerciseRequest;
    result: Record<string, any>;
    assertions: CliFixtureAssertions;
    notes?: string;
};
export declare function validateCliFixtureResult(result: any, assertions: CliFixtureAssertions): string[];
export declare function runCliExerciseInternal(ctx: DevServerContext, body: CliExerciseRequest): Promise<Record<string, any>>;
export declare function runCliAutoImplVerification(ctx: DevServerContext, type: string, verification?: {
    request?: Record<string, any>;
    mustContainAny?: string[];
    mustNotContainAny?: string[];
    mustMatchAny?: string[];
    mustNotMatchAny?: string[];
    lastAssistantMustContainAny?: string[];
    lastAssistantMustNotContainAny?: string[];
    lastAssistantMustMatchAny?: string[];
    lastAssistantMustNotMatchAny?: string[];
    fixtureName?: string;
    fixtureNames?: string[];
}): Promise<{
    mode: 'fixture_replay' | 'fixture_replay_suite' | 'exercise';
    pass: boolean;
    failures: string[];
    result: Record<string, any>;
    assertions: CliFixtureAssertions;
    fixture?: CliExerciseFixture;
    results?: Array<{
        fixtureName: string;
        pass: boolean;
        failures: string[];
        result: Record<string, any>;
        assertions: CliFixtureAssertions;
        fixture: CliExerciseFixture;
    }>;
}>;
/** GET /api/cli/status — list all running CLI/ACP instances with state */
export declare function handleCliStatus(ctx: DevServerContext, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
export declare function handleCliLaunch(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/send — send message to a running CLI { type, text } */
export declare function handleCliSend(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/stop — stop a running CLI { type } */
export declare function handleCliStop(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** GET /api/cli/events — SSE stream of CLI status events */
export declare function handleCliSSE(ctx: DevServerContext, cliSSEClients: http.ServerResponse[], _req: http.IncomingMessage, res: http.ServerResponse): void;
/** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
export declare function handleCliDebug(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** GET /api/cli/trace/:type — recent CLI trace timeline plus current debug snapshot */
export declare function handleCliTrace(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/exercise — autonomously run a CLI repro and wait for final settled trace */
export declare function handleCliExercise(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/fixture/capture — run exact exercise once and persist it as a reusable fixture */
export declare function handleCliFixtureCapture(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** GET /api/cli/fixtures/:type — list saved exercise fixtures for a provider */
export declare function handleCliFixtureList(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/fixture/replay — rerun a saved exact exercise and validate against saved assertions */
export declare function handleCliFixtureReplay(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
export declare function handleCliResolve(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
/** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
export declare function handleCliRaw(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
export {};
