/**
 * DevServer — CLI Debug Handlers
 *
 * Extracted from dev-server.ts for maintainability.
 * All functions take a DevServerContext as their first argument.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as http from 'http';
import type { DevServerContext } from './dev-server-types.js';

// ─── Helpers ──────────────────────────────────────

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

function slugifyFixtureName(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `fixture-${Date.now()}`;
}

function getCliFixtureDir(ctx: DevServerContext, type: string): string {
  const providerDir = ctx.providerLoader.findProviderDir(type);
  if (!providerDir) {
    throw new Error(`Provider directory not found for '${type}'`);
  }
  return path.join(providerDir, 'fixtures');
}

function readCliFixture(ctx: DevServerContext, type: string, name: string): CliExerciseFixture {
  const fixtureDir = getCliFixtureDir(ctx, type);
  const filePath = path.join(fixtureDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getExerciseTranscriptText(result: any): string {
  const parts: string[] = [];
  const debugMessages = Array.isArray(result?.debug?.messages) ? result.debug.messages : [];
  const traceMessages = Array.isArray(result?.trace?.messages) ? result.trace.messages : [];

  for (const message of [...debugMessages, ...traceMessages]) {
    if (!message || typeof message.content !== 'string') continue;
    parts.push(message.content);
  }

  if (typeof result?.debug?.partialResponse === 'string') parts.push(result.debug.partialResponse);
  if (typeof result?.trace?.responseBuffer === 'string') parts.push(result.trace.responseBuffer);

  return parts.join('\n');
}

function getExerciseLastAssistant(result: any): string {
  const debugMessages = Array.isArray(result?.debug?.messages) ? result.debug.messages : [];
  const traceMessages = Array.isArray(result?.trace?.messages) ? result.trace.messages : [];
  for (const messages of [debugMessages, traceMessages]) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
        return message.content;
      }
    }
  }
  return '';
}

function getExerciseMessageCount(result: any): number {
  const debugMessages = Array.isArray(result?.debug?.messages) ? result.debug.messages : [];
  const traceMessages = Array.isArray(result?.trace?.messages) ? result.trace.messages : [];
  return Math.max(debugMessages.length, traceMessages.length);
}

function compileFixtureRegex(source: string): RegExp | null {
  const value = String(source || '').trim();
  if (!value) return null;
  const delimited = value.match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
  try {
    if (delimited) {
      return new RegExp(delimited[1], delimited[2]);
    }
    return new RegExp(value, 'm');
  } catch {
    return null;
  }
}

function statusesContainSequence(actual: string[], expected: string[]): boolean {
  if (!expected.length) return true;
  let index = 0;
  for (const status of actual) {
    if (status === expected[index]) index += 1;
    if (index >= expected.length) return true;
  }
  return false;
}

export function validateCliFixtureResult(result: any, assertions: CliFixtureAssertions): string[] {
  const failures: string[] = [];
  const transcriptText = getExerciseTranscriptText(result);
  const lastAssistant = getExerciseLastAssistant(result);
  const mustContainAny = assertions.mustContainAny || [];
  const mustNotContainAny = assertions.mustNotContainAny || [];
  const mustMatchAny = assertions.mustMatchAny || [];
  const mustNotMatchAny = assertions.mustNotMatchAny || [];
  const lastAssistantMustContainAny = assertions.lastAssistantMustContainAny || [];
  const lastAssistantMustNotContainAny = assertions.lastAssistantMustNotContainAny || [];
  const lastAssistantMustMatchAny = assertions.lastAssistantMustMatchAny || [];
  const lastAssistantMustNotMatchAny = assertions.lastAssistantMustNotMatchAny || [];
  const statusesSeen = Array.isArray(result?.statusesSeen) ? result.statusesSeen.map((value: any) => String(value)) : [];

  if (assertions.requireNotTimedOut !== false && result?.timedOut) {
    failures.push('Exercise timed out');
  }

  const missingRequired = mustContainAny.filter((value) => !transcriptText.includes(value));
  if (missingRequired.length > 0) {
    failures.push(`Missing required substrings: ${missingRequired.join(', ')}`);
  }

  const presentBanned = mustNotContainAny.filter((value) => transcriptText.includes(value));
  if (presentBanned.length > 0) {
    failures.push(`Found banned substrings: ${presentBanned.join(', ')}`);
  }

  const missingRegex = mustMatchAny.filter((value) => {
    const regex = compileFixtureRegex(value);
    return !regex || !regex.test(transcriptText);
  });
  if (missingRegex.length > 0) {
    failures.push(`Missing required regex matches: ${missingRegex.join(', ')}`);
  }

  const presentBannedRegex = mustNotMatchAny.filter((value) => {
    const regex = compileFixtureRegex(value);
    return !!regex && regex.test(transcriptText);
  });
  if (presentBannedRegex.length > 0) {
    failures.push(`Found banned regex matches: ${presentBannedRegex.join(', ')}`);
  }

  const missingLastAssistant = lastAssistantMustContainAny.filter((value) => !lastAssistant.includes(value));
  if (missingLastAssistant.length > 0) {
    failures.push(`Missing required lastAssistant substrings: ${missingLastAssistant.join(', ')}`);
  }

  const presentBannedLastAssistant = lastAssistantMustNotContainAny.filter((value) => lastAssistant.includes(value));
  if (presentBannedLastAssistant.length > 0) {
    failures.push(`Found banned lastAssistant substrings: ${presentBannedLastAssistant.join(', ')}`);
  }

  const missingLastAssistantRegex = lastAssistantMustMatchAny.filter((value) => {
    const regex = compileFixtureRegex(value);
    return !regex || !regex.test(lastAssistant);
  });
  if (missingLastAssistantRegex.length > 0) {
    failures.push(`Missing required lastAssistant regex matches: ${missingLastAssistantRegex.join(', ')}`);
  }

  const presentBannedLastAssistantRegex = lastAssistantMustNotMatchAny.filter((value) => {
    const regex = compileFixtureRegex(value);
    return !!regex && regex.test(lastAssistant);
  });
  if (presentBannedLastAssistantRegex.length > 0) {
    failures.push(`Found banned lastAssistant regex matches: ${presentBannedLastAssistantRegex.join(', ')}`);
  }

  if (assertions.statusesSeen?.length && !statusesContainSequence(statusesSeen, assertions.statusesSeen)) {
    failures.push(`Expected statuses sequence not observed: ${assertions.statusesSeen.join(' -> ')}`);
  }

  if (result && typeof result === 'object') {
    result.lastAssistant = lastAssistant;
  }

  return failures;
}

function getCliProviderResolutionMeta(ctx: DevServerContext, type: string, adapter?: any): Record<string, any> | null {
  const adapterMeta = typeof adapter?.getProviderResolutionMeta === 'function'
    ? adapter.getProviderResolutionMeta()
    : (adapter?.getDebugState?.()?.providerResolution || null);
  const resolvedProvider = ctx.providerLoader.resolve(type);
  if (!adapterMeta && !resolvedProvider) return null;
  return {
    type,
    providerDir: adapterMeta?.providerDir || resolvedProvider?._resolvedProviderDir || ctx.providerLoader.findProviderDir(type),
    scriptDir: adapterMeta?.scriptDir || resolvedProvider?._resolvedScriptDir || null,
    scriptsPath: adapterMeta?.scriptsPath || resolvedProvider?._resolvedScriptsPath || null,
    scriptsSource: adapterMeta?.scriptsSource || resolvedProvider?._resolvedScriptsSource || null,
    resolvedVersion: adapterMeta?.resolvedVersion || resolvedProvider?._resolvedVersion || null,
    resolvedOs: adapterMeta?.resolvedOs || resolvedProvider?._resolvedOs || null,
    versionWarning: adapterMeta?.versionWarning || resolvedProvider?._versionWarning || null,
  };
}

function findCliTarget(ctx: DevServerContext, type?: string, instanceId?: string): any | null {
  if (!ctx.instanceManager) return null;
  const cliStates = ctx.instanceManager
    .collectAllStates()
    .filter(s => s.category === 'cli' || s.category === 'acp');
  if (instanceId) return cliStates.find(s => s.instanceId === instanceId) || null;
  if (!type) return cliStates[cliStates.length - 1] || null;
  const matches = cliStates.filter(s => s.type === type);
  return matches[matches.length - 1] || null;
}

function getCliTargetBundle(ctx: DevServerContext, type?: string, instanceId?: string): {
  target: any;
  instance: any;
  adapter: any;
} | null {
  if (!ctx.instanceManager) return null;
  const target = findCliTarget(ctx, type, instanceId);
  if (!target) return null;
  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  if (!instance) return null;
  const adapter = instance.getAdapter?.() || instance.adapter;
  if (!adapter) return null;
  return { target, instance, adapter };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCliReady(
  ctx: DevServerContext,
  type: string,
  instanceId: string,
  timeoutMs: number,
): Promise<{ target: any; instance: any; adapter: any } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bundle = getCliTargetBundle(ctx, type, instanceId);
    if (bundle) {
      const debug = typeof bundle.adapter.getDebugState === 'function'
        ? bundle.adapter.getDebugState()
        : null;
      const startupParseGate = !!debug?.startupParseGate;
      const adapterReady = !!debug?.ready;
      const visibleStatusReady = bundle.target.status === 'generating' || bundle.target.status === 'waiting_approval';
      const idleReady = bundle.target.status === 'idle' && !startupParseGate;
      if (adapterReady || visibleStatusReady || idleReady) {
        return bundle;
      }
    }
    await sleep(100);
  }
  return getCliTargetBundle(ctx, type, instanceId);
}

export async function runCliExerciseInternal(ctx: DevServerContext, body: CliExerciseRequest): Promise<Record<string, any>> {
  if (!ctx.cliManager) {
    throw new Error('CliManager not available');
  }
  if (!ctx.instanceManager) {
    throw new Error('InstanceManager not available');
  }

  const {
    type,
    text,
    instanceId: requestedInstanceId,
    workingDir,
    args,
    autoLaunch = true,
    freshSession = true,
    autoResolveApprovals = true,
    approvalButtonIndex = 0,
    timeoutMs = 45_000,
    readyTimeoutMs = 15_000,
    idleSettledMs = 1_200,
    traceLimit = 160,
    stopWhenDone = false,
  } = body || {};

  if (!type) {
    throw new Error('type required (e.g. claude-cli, codex-cli)');
  }
  if (!text || typeof text !== 'string') {
    throw new Error('text required (prompt to send to the CLI)');
  }

  let resolvedInstanceId = requestedInstanceId as string | undefined;

  if (freshSession) {
    const staleTargets = ctx.instanceManager
      .collectAllStates()
      .filter((state) => (state.category === 'cli' || state.category === 'acp') && state.type === type)
      .map((state) => state.instanceId);
    for (const staleId of staleTargets) {
      ctx.instanceManager.removeInstance(staleId);
    }
    resolvedInstanceId = undefined;
  }

  let bundle = getCliTargetBundle(ctx, type, resolvedInstanceId);
  if (!bundle && autoLaunch) {
    const launchArgs = [type, workingDir || process.cwd(), Array.isArray(args) ? args : []] as const;
    let launched: { runtimeSessionId: string; providerSessionId?: string } | null = null;
    let lastLaunchError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        launched = await ctx.cliManager.startSession(...launchArgs);
        lastLaunchError = null;
        break;
      } catch (error: any) {
        lastLaunchError = error instanceof Error ? error : new Error(String(error?.message || error));
        const message = String(lastLaunchError.message || '');
        const retryable = /ECONNREFUSED|session-host|Session host/i.test(message);
        if (!retryable || attempt === 2) break;
        await sleep(1_000);
      }
    }
    if (!launched) {
      throw lastLaunchError || new Error(`Failed to start ${type}`);
    }
    resolvedInstanceId = launched.runtimeSessionId;
    bundle = await waitForCliReady(ctx, type, resolvedInstanceId, Math.max(1_000, readyTimeoutMs));
  }

  if (!bundle) {
    throw new Error(`No running instance found for: ${resolvedInstanceId || type}`);
  }

  const initialDebug = typeof bundle.adapter.getDebugState === 'function' ? bundle.adapter.getDebugState() : null;
  const initialTrace = typeof bundle.adapter.getTraceState === 'function' ? bundle.adapter.getTraceState(traceLimit) : null;
  const providerResolution = getCliProviderResolutionMeta(ctx, bundle.target.type, bundle.adapter);
  const preTraceCount = Number(initialTrace?.entryCount || 0);
  const startAt = Date.now();
  const statusesSeen: string[] = [];
  const approvalsResolved: { at: number; buttonIndex: number; label: string | null }[] = [];
  let lastStatus = '';
  let lastModalKey = '';
  let idleSince = 0;
  let sawBusy = false;

  ctx.instanceManager.sendEvent(bundle.target.instanceId, 'send_message', { text });

  while (Date.now() - startAt < Math.max(1_000, timeoutMs)) {
    await sleep(150);
    bundle = getCliTargetBundle(ctx, type, bundle.target.instanceId);
    if (!bundle) {
      throw new Error('CLI instance disappeared during exercise');
    }

    const debug = typeof bundle.adapter.getDebugState === 'function' ? bundle.adapter.getDebugState() : null;
    const trace = typeof bundle.adapter.getTraceState === 'function' ? bundle.adapter.getTraceState(traceLimit) : null;
    const status = String(debug?.status || bundle.target.status || 'unknown');
    const traceEntries = Array.isArray(trace?.entries) ? trace.entries : [];
    const sawSendMessage = traceEntries.some((entry: any) => entry?.type === 'send_message');
    const sawSubmitWrite = traceEntries.some((entry: any) => entry?.type === 'submit_write');
    const hasTurnStarted = sawSendMessage || sawSubmitWrite || !!debug?.currentTurnScope;

    if (status !== lastStatus) {
      statusesSeen.push(status);
      lastStatus = status;
    }

    if (status === 'generating' || status === 'waiting_approval') {
      sawBusy = true;
      idleSince = 0;
    }

    const modal = debug?.activeModal || trace?.activeModal || null;
    if (autoResolveApprovals && status === 'waiting_approval' && modal && Array.isArray(modal.buttons) && modal.buttons.length > 0) {
      const clampedIndex = Math.max(0, Math.min(Number(approvalButtonIndex) || 0, modal.buttons.length - 1));
      const modalKey = JSON.stringify({
        message: modal.message || '',
        buttons: modal.buttons,
        index: clampedIndex,
      });
      if (modalKey !== lastModalKey && typeof bundle.adapter.resolveModal === 'function') {
        lastModalKey = modalKey;
        approvalsResolved.push({
          at: Date.now(),
          buttonIndex: clampedIndex,
          label: modal.buttons[clampedIndex] || null,
        });
        bundle.adapter.resolveModal(clampedIndex);
        continue;
      }
    }

    const traceCount = Number(trace?.entryCount || 0);
    const hasProgress = hasTurnStarted && (traceCount > preTraceCount || statusesSeen.length > 1 || approvalsResolved.length > 0);
    if (status === 'idle' && hasProgress && sawBusy) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= Math.max(200, idleSettledMs)) {
        const payload: Record<string, any> = {
          exercised: true,
          instanceId: bundle.target.instanceId,
          providerState: {
            type: bundle.target.type,
            name: bundle.target.name,
            status: bundle.target.status,
            mode: 'mode' in bundle.target ? bundle.target.mode : undefined,
          },
          providerResolution,
          initialDebug,
          initialTrace,
          debug,
          trace,
          statusesSeen,
          approvalsResolved,
          elapsedMs: Date.now() - startAt,
          timedOut: false,
        };
        payload.lastAssistant = getExerciseLastAssistant(payload);
        payload.messageCount = getExerciseMessageCount(payload);
        if (stopWhenDone) {
          ctx.instanceManager.removeInstance(bundle.target.instanceId);
        }
        return payload;
      }
    } else if (status === 'idle' && hasProgress) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= Math.max(500, idleSettledMs) && Date.now() - startAt >= 750) {
        const payload: Record<string, any> = {
          exercised: true,
          instanceId: bundle.target.instanceId,
          providerState: {
            type: bundle.target.type,
            name: bundle.target.name,
            status: bundle.target.status,
            mode: 'mode' in bundle.target ? bundle.target.mode : undefined,
          },
          providerResolution,
          initialDebug,
          initialTrace,
          debug,
          trace,
          statusesSeen,
          approvalsResolved,
          elapsedMs: Date.now() - startAt,
          timedOut: false,
        };
        payload.lastAssistant = getExerciseLastAssistant(payload);
        payload.messageCount = getExerciseMessageCount(payload);
        if (stopWhenDone) {
          ctx.instanceManager.removeInstance(bundle.target.instanceId);
        }
        return payload;
      }
    } else {
      idleSince = 0;
    }
  }

  const finalBundle = getCliTargetBundle(ctx, type, bundle.target.instanceId) || bundle;
  const finalDebug = typeof finalBundle.adapter.getDebugState === 'function' ? finalBundle.adapter.getDebugState() : null;
  const finalTrace = typeof finalBundle.adapter.getTraceState === 'function' ? finalBundle.adapter.getTraceState(traceLimit) : null;
  if (stopWhenDone) {
    ctx.instanceManager.removeInstance(finalBundle.target.instanceId);
  }
  const payload: Record<string, any> = {
    exercised: true,
    instanceId: finalBundle.target.instanceId,
    providerState: {
      type: finalBundle.target.type,
      name: finalBundle.target.name,
      status: finalBundle.target.status,
      mode: 'mode' in finalBundle.target ? finalBundle.target.mode : undefined,
    },
    providerResolution: getCliProviderResolutionMeta(ctx, finalBundle.target.type, finalBundle.adapter),
    initialDebug,
    initialTrace,
    debug: finalDebug,
    trace: finalTrace,
    statusesSeen,
    approvalsResolved,
    elapsedMs: Date.now() - startAt,
    timedOut: true,
  };
  payload.lastAssistant = getExerciseLastAssistant(payload);
  payload.messageCount = getExerciseMessageCount(payload);
  return payload;
}

export async function runCliAutoImplVerification(
  ctx: DevServerContext,
  type: string,
  verification?: {
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
  },
): Promise<{
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
}> {
  const assertions: CliFixtureAssertions = {
    mustContainAny: verification?.mustContainAny || [],
    mustNotContainAny: verification?.mustNotContainAny || [],
    mustMatchAny: verification?.mustMatchAny || [],
    mustNotMatchAny: verification?.mustNotMatchAny || [],
    lastAssistantMustContainAny: verification?.lastAssistantMustContainAny || [],
    lastAssistantMustNotContainAny: verification?.lastAssistantMustNotContainAny || [],
    lastAssistantMustMatchAny: verification?.lastAssistantMustMatchAny || [],
    lastAssistantMustNotMatchAny: verification?.lastAssistantMustNotMatchAny || [],
    requireNotTimedOut: true,
  };

  const rawFixtureNames = Array.isArray(verification?.fixtureNames)
    ? verification!.fixtureNames.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (rawFixtureNames.length > 0) {
    const results: Array<{
      fixtureName: string;
      pass: boolean;
      failures: string[];
      result: Record<string, any>;
      assertions: CliFixtureAssertions;
      fixture: CliExerciseFixture;
    }> = [];
    for (const rawFixtureName of rawFixtureNames) {
      const name = slugifyFixtureName(rawFixtureName);
      const fixture = readCliFixture(ctx, type, name);
      const mergedAssertions: CliFixtureAssertions = {
        ...fixture.assertions,
        ...assertions,
      };
      const result = await runCliExerciseInternal(ctx, {
        ...fixture.request,
        type,
      });
      const failures = validateCliFixtureResult(result, mergedAssertions);
      results.push({
        fixtureName: name,
        pass: failures.length === 0,
        failures,
        result,
        assertions: mergedAssertions,
        fixture,
      });
    }
    const firstFailure = results.find((item) => !item.pass) || results[results.length - 1];
    return {
      mode: 'fixture_replay_suite',
      pass: results.every((item) => item.pass),
      failures: results.flatMap((item) => item.failures.map((failure) => `${item.fixtureName}: ${failure}`)),
      result: firstFailure.result,
      assertions: firstFailure.assertions,
      fixture: firstFailure.fixture,
      results,
    };
  }

  const rawFixtureName = String(verification?.fixtureName || '').trim();
  if (rawFixtureName) {
    const name = slugifyFixtureName(rawFixtureName);
    try {
      const fixture = readCliFixture(ctx, type, name);
      const mergedAssertions: CliFixtureAssertions = {
        ...fixture.assertions,
        ...assertions,
      };
      const result = await runCliExerciseInternal(ctx, {
        ...fixture.request,
        type,
      });
      const failures = validateCliFixtureResult(result, mergedAssertions);
      return {
        mode: 'fixture_replay',
        pass: failures.length === 0,
        failures,
        result,
        assertions: mergedAssertions,
        fixture,
      };
    } catch {
      // Fall through to direct exercise verification if the named fixture is absent.
    }
  }

  const result = await runCliExerciseInternal(ctx, {
    ...(verification?.request || {}),
    type,
  });
  const failures = validateCliFixtureResult(result, assertions);
  return {
    mode: 'exercise',
    pass: failures.length === 0,
    failures,
    result,
    assertions,
  };
}

// ─── Handlers ─────────────────────────────────────

/** GET /api/cli/status — list all running CLI/ACP instances with state */
export async function handleCliStatus(ctx: DevServerContext, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available (daemon not fully initialized)' });
    return;
  }
  const allStates = ctx.instanceManager.collectAllStates();
  const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
  const result = cliStates.map(s => ({
    instanceId: s.instanceId,
    type: s.type,
    name: s.name,
    category: s.category,
    status: s.status,
    mode: s.mode,
    workspace: s.workspace,
    messageCount: s.activeChat?.messages?.length || 0,
    lastMessage: s.activeChat?.messages?.slice(-1)[0] || null,
    activeModal: s.activeChat?.activeModal || null,
    pendingEvents: s.pendingEvents || [],
    currentModel: s.currentModel,
    settings: s.settings,
  }));
  ctx.json(res, 200, { instances: result, count: result.length });
}

/** POST /api/cli/launch — launch a CLI agent { type, workingDir?, args? } */
export async function handleCliLaunch(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, workingDir, args } = body;
  if (!type) {
    ctx.json(res, 400, { error: 'type required (e.g. claude-cli, gemini-cli)' });
    return;
  }
  try {
    await ctx.cliManager.startSession(type, workingDir || process.cwd(), args || []);
    ctx.json(res, 200, { launched: true, type, workspace: workingDir || process.cwd() });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Launch failed: ${e.message}` });
  }
}

/** POST /api/cli/send — send message to a running CLI { type, text } */
export async function handleCliSend(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, text, instanceId } = body;
  if (!text) {
    ctx.json(res, 400, { error: 'text required' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
    return;
  }

  try {
    ctx.instanceManager!.sendEvent(target.instanceId, 'send_message', { text });
    ctx.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Send failed: ${e.message}` });
  }
}

/** POST /api/cli/stop — stop a running CLI { type } */
export async function handleCliStop(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }
  const body = await ctx.readBody(req);
  const { type, instanceId } = body;

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running instance found for: ${type || instanceId}` });
    return;
  }

  try {
    ctx.instanceManager!.removeInstance(target.instanceId);
    ctx.json(res, 200, { stopped: true, type: target.type, instanceId: target.instanceId });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Stop failed: ${e.message}` });
  }
}

/** GET /api/cli/events — SSE stream of CLI status events */
export function handleCliSSE(ctx: DevServerContext, cliSSEClients: http.ServerResponse[], _req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  cliSSEClients.push(res);

  // Register event listener if first client + instanceManager available
  if (cliSSEClients.length === 1 && ctx.instanceManager) {
    ctx.instanceManager.onEvent((event) => {
      ctx.sendCliSSE(event);
    });
  }

  // Send current state snapshot immediately
  if (ctx.instanceManager) {
    const allStates = ctx.instanceManager.collectAllStates();
    const cliStates = allStates.filter(s => s.category === 'cli' || s.category === 'acp');
    for (const s of cliStates) {
      ctx.sendCliSSE({ event: 'snapshot', providerType: s.type, status: s.status, instanceId: s.instanceId });
    }
  }

  _req.on('close', () => {
    const idx = cliSSEClients.indexOf(res);
    if (idx >= 0) cliSSEClients.splice(idx, 1);
  });
}

/** GET /api/cli/debug/:type — full internal debug state of a CLI adapter */
export async function handleCliDebug(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type);
  if (!target) {
    const allStates = ctx.instanceManager.collectAllStates();
    ctx.json(res, 404, { error: `No running instance for: ${type}`, available: allStates.filter(s => s.category === 'cli' || s.category === 'acp').map(s => s.type) });
    return;
  }

  // Get the ProviderInstance and access adapter debug state
  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  if (!instance) {
    ctx.json(res, 404, { error: `Instance not found: ${target.instanceId}` });
    return;
  }

  try {
    const adapter = instance.getAdapter?.() || instance.adapter;
    if (adapter && typeof adapter.getDebugState === 'function') {
      const debugState = adapter.getDebugState();
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: {
          type: target.type,
          name: target.name,
          status: target.status,
          mode: 'mode' in target ? target.mode : undefined,
        },
        providerResolution: getCliProviderResolutionMeta(ctx, target.type, adapter),
        debug: debugState,
      });
    } else {
      // Fallback: return what we can from the state
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: target,
        providerResolution: getCliProviderResolutionMeta(ctx, target.type, adapter),
        debug: null,
        message: 'No debug state available (adapter.getDebugState not found)',
      });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Debug state failed: ${e.message}` });
  }
}

/** GET /api/cli/trace/:type — recent CLI trace timeline plus current debug snapshot */
export async function handleCliTrace(ctx: DevServerContext, type: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type);
  if (!target) {
    const allStates = ctx.instanceManager.collectAllStates();
    ctx.json(res, 404, {
      error: `No running instance for: ${type}`,
      available: allStates.filter(s => s.category === 'cli' || s.category === 'acp').map(s => s.type),
    });
    return;
  }

  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  if (!instance) {
    ctx.json(res, 404, { error: `Instance not found: ${target.instanceId}` });
    return;
  }

  try {
    const adapter = instance.getAdapter?.() || instance.adapter;
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const limit = parseInt(url.searchParams.get('limit') || '120', 10);
    if (adapter && typeof adapter.getTraceState === 'function') {
      const trace = adapter.getTraceState(limit);
      const debug = typeof adapter.getDebugState === 'function' ? adapter.getDebugState() : null;
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: {
          type: target.type,
          name: target.name,
          status: target.status,
          mode: 'mode' in target ? target.mode : undefined,
        },
        providerResolution: getCliProviderResolutionMeta(ctx, target.type, adapter),
        debug,
        trace,
      });
    } else {
      ctx.json(res, 200, {
        instanceId: target.instanceId,
        providerState: target,
        providerResolution: getCliProviderResolutionMeta(ctx, target.type, adapter),
        debug: typeof adapter?.getDebugState === 'function' ? adapter.getDebugState() : null,
        trace: null,
        message: 'No trace state available (adapter.getTraceState not found)',
      });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Trace state failed: ${e.message}` });
  }
}

/** POST /api/cli/exercise — autonomously run a CLI repro and wait for final settled trace */
export async function handleCliExercise(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await ctx.readBody(req);
    const result = await runCliExerciseInternal(ctx, body || {});
    ctx.json(res, 200, result);
  } catch (e: any) {
    ctx.json(res, 500, { error: `Exercise failed: ${e.message}` });
  }
}

/** POST /api/cli/fixture/capture — run exact exercise once and persist it as a reusable fixture */
export async function handleCliFixtureCapture(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await ctx.readBody(req);
    const type = String(body?.type || '');
    const request = (body?.request || {}) as CliExerciseRequest;
    if (!type) {
      ctx.json(res, 400, { error: 'type required' });
      return;
    }
    if (!request?.text) {
      ctx.json(res, 400, { error: 'request.text required' });
      return;
    }

    const fixtureDir = getCliFixtureDir(ctx, type);
    fs.mkdirSync(fixtureDir, { recursive: true });
    const name = slugifyFixtureName(String(body?.name || `${type}-${Date.now()}`));
    const result = await runCliExerciseInternal(ctx, { ...request, type });
    const fixture: CliExerciseFixture = {
      version: 1,
      kind: 'cli-exercise-fixture',
      name,
      type,
      createdAt: new Date().toISOString(),
      providerDir: ctx.providerLoader.findProviderDir(type),
      providerResolution: result?.providerResolution || null,
      request: { ...request, type },
      result,
      assertions: {
        mustContainAny: Array.isArray(body?.assertions?.mustContainAny) ? body.assertions.mustContainAny : [],
        mustNotContainAny: Array.isArray(body?.assertions?.mustNotContainAny) ? body.assertions.mustNotContainAny : [],
        mustMatchAny: Array.isArray(body?.assertions?.mustMatchAny) ? body.assertions.mustMatchAny : [],
        mustNotMatchAny: Array.isArray(body?.assertions?.mustNotMatchAny) ? body.assertions.mustNotMatchAny : [],
        lastAssistantMustContainAny: Array.isArray(body?.assertions?.lastAssistantMustContainAny) ? body.assertions.lastAssistantMustContainAny : [],
        lastAssistantMustNotContainAny: Array.isArray(body?.assertions?.lastAssistantMustNotContainAny) ? body.assertions.lastAssistantMustNotContainAny : [],
        lastAssistantMustMatchAny: Array.isArray(body?.assertions?.lastAssistantMustMatchAny) ? body.assertions.lastAssistantMustMatchAny : [],
        lastAssistantMustNotMatchAny: Array.isArray(body?.assertions?.lastAssistantMustNotMatchAny) ? body.assertions.lastAssistantMustNotMatchAny : [],
        statusesSeen: Array.isArray(body?.assertions?.statusesSeen) ? body.assertions.statusesSeen : undefined,
        requireNotTimedOut: body?.assertions?.requireNotTimedOut !== false,
      },
      notes: typeof body?.notes === 'string' ? body.notes : undefined,
    };
    const filePath = path.join(fixtureDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
    ctx.json(res, 200, {
      saved: true,
      name,
      path: filePath,
      fixture,
      verification: {
        pass: validateCliFixtureResult(result, fixture.assertions).length === 0,
        failures: validateCliFixtureResult(result, fixture.assertions),
      },
    });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Fixture capture failed: ${e.message}` });
  }
}

/** GET /api/cli/fixtures/:type — list saved exercise fixtures for a provider */
export async function handleCliFixtureList(ctx: DevServerContext, type: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const fixtureDir = getCliFixtureDir(ctx, type);
    if (!fs.existsSync(fixtureDir)) {
      ctx.json(res, 200, { fixtures: [], count: 0 });
      return;
    }
    const fixtures = fs.readdirSync(fixtureDir)
      .filter((file) => file.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((file) => {
        const fullPath = path.join(fixtureDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as CliExerciseFixture;
          return {
            name: raw.name || file.replace(/\.json$/i, ''),
            path: fullPath,
            createdAt: raw.createdAt || null,
            notes: raw.notes || null,
            requestText: raw.request?.text || '',
            assertions: raw.assertions || {},
          };
        } catch {
          return {
            name: file.replace(/\.json$/i, ''),
            path: fullPath,
            createdAt: null,
            notes: 'Unreadable fixture',
            requestText: '',
            assertions: {},
          };
        }
      });
    ctx.json(res, 200, { fixtures, count: fixtures.length });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Fixture list failed: ${e.message}` });
  }
}

/** POST /api/cli/fixture/replay — rerun a saved exact exercise and validate against saved assertions */
export async function handleCliFixtureReplay(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await ctx.readBody(req);
    const type = String(body?.type || '');
    const rawName = String(body?.name || '').trim();
    if (!type || !rawName) {
      ctx.json(res, 400, { error: 'type and name required' });
      return;
    }
    const name = slugifyFixtureName(rawName);

    const fixture = readCliFixture(ctx, type, name);
    const result = await runCliExerciseInternal(ctx, {
      ...fixture.request,
      type,
    });
    const assertions: CliFixtureAssertions = {
      ...fixture.assertions,
      ...(body?.assertions || {}),
    };
    const failures = validateCliFixtureResult(result, assertions);
    ctx.json(res, 200, {
      replayed: true,
      pass: failures.length === 0,
      failures,
      fixture,
      result,
      assertions,
    });
  } catch (e: any) {
    ctx.json(res, 500, { error: `Fixture replay failed: ${e.message}` });
  }
}

/** POST /api/cli/resolve — resolve an approval modal { type, buttonIndex } */
export async function handleCliResolve(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { type, buttonIndex, instanceId } = body;
  if (buttonIndex === undefined || buttonIndex === null) {
    ctx.json(res, 400, { error: 'buttonIndex required (0=Yes, 1=Always, 2=Deny)' });
    return;
  }

  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
    return;
  }

  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  const adapter = instance?.getAdapter?.() || instance?.adapter;
  if (!adapter) {
    ctx.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
    return;
  }

  try {
    if (typeof adapter.resolveModal === 'function') {
      adapter.resolveModal(buttonIndex);
      ctx.json(res, 200, { resolved: true, type: target.type, instanceId: target.instanceId, buttonIndex });
    } else {
      ctx.json(res, 400, { error: 'resolveModal not available on this adapter' });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Resolve failed: ${e.message}` });
  }
}

/** POST /api/cli/raw — send raw keystrokes to PTY { type, keys } */
export async function handleCliRaw(ctx: DevServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await ctx.readBody(req);
  const { type, keys, instanceId } = body;
  if (!keys) {
    ctx.json(res, 400, { error: 'keys required (raw string to send to PTY)' });
    return;
  }

  if (!ctx.cliManager) {
    ctx.json(res, 503, { error: 'CliManager not available' });
    return;
  }
  if (!ctx.instanceManager) {
    ctx.json(res, 503, { error: 'InstanceManager not available' });
    return;
  }

  const target = findCliTarget(ctx, type, instanceId);
  if (!target) {
    ctx.json(res, 404, { error: `No running adapter for: ${type || instanceId}` });
    return;
  }

  const instance = ctx.instanceManager.getInstance(target.instanceId) as any;
  const adapter = instance?.getAdapter?.() || instance?.adapter;
  if (!adapter) {
    ctx.json(res, 404, { error: `Adapter not found for instance: ${target.instanceId}` });
    return;
  }

  try {
    if (typeof adapter.writeRaw === 'function') {
      adapter.writeRaw(keys);
      ctx.json(res, 200, { sent: true, type: target.type, instanceId: target.instanceId, keysLength: keys.length });
    } else {
      ctx.json(res, 400, { error: 'writeRaw not available on this adapter' });
    }
  } catch (e: any) {
    ctx.json(res, 500, { error: `Raw send failed: ${e.message}` });
  }
}
