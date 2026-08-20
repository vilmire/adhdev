/**
 * Stream Commands — Agent Stream, PTY I/O, Provider Settings,
 *                   IDE Extension Settings, Extension Script Execution
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import type { ProviderInstance } from '../providers/provider-instance.js';
import { loadConfig, saveConfig } from '../config/config.js';
import { parseProviderSourceConfigUpdate } from '../config/provider-source-config.js';
import { getCliScriptCommand, parseCliScriptResult } from '../providers/cli-script-results.js';
import {
    normalizeControlInvokeResult,
    normalizeControlListResult,
    normalizeControlSetResult,
} from '../providers/control-effects.js';
import { LOG } from '../logging/logger.js';

interface CliPresentationInstance extends ProviderInstance {
    getPresentationMode?(): 'terminal' | 'chat';
}

function getCliPresentationMode(h: CommandHelpers, targetSessionId?: string): 'terminal' | 'chat' | null {
    if (!targetSessionId) return null;
    const instance = h.ctx.instanceManager?.getInstance(targetSessionId) as CliPresentationInstance | undefined;
    if (instance?.category !== 'cli') return null;
    const mode = instance.getPresentationMode?.();
    return mode === 'chat' || mode === 'terminal' ? mode : null;
}

function normalizeOpenPanelCommandResult(result: CommandResult): { opened: boolean; visible: boolean; focused: boolean } {
    const payload = Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
    if (payload === true) return { opened: true, visible: true, focused: false };
    if (!payload) return { opened: false, visible: false, focused: false };
    if (typeof payload === 'string') {
        const normalized = payload.trim().toLowerCase();
        if (normalized === 'visible') return { opened: false, visible: true, focused: false };
        if (normalized === 'focused') return { opened: false, visible: true, focused: true };
        if (normalized === 'opened' || normalized === 'open' || normalized === 'true' || normalized === 'ok' || normalized === 'success') {
            return { opened: true, visible: true, focused: false };
        }
        return { opened: false, visible: false, focused: false };
    }
    if (typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        return {
            opened: record.opened === true,
            visible: record.visible === true || record.opened === true || record.focused === true,
            focused: record.focused === true,
        };
    }
    return { opened: false, visible: false, focused: false };
}

function normalizeFocusEditorCommandResult(result: CommandResult): { focused: boolean } {
    const payload = Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
    if (payload === true) return { focused: true };
    if (!payload) return { focused: false };
    if (typeof payload === 'string') {
        const normalized = payload.trim().toLowerCase();
        return { focused: normalized === 'focused' || normalized === 'visible' || normalized === 'true' || normalized === 'ok' || normalized === 'success' };
    }
    if (typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        return { focused: record.focused === true || record.visible === true || record.success === true || record.ok === true };
    }
    return { focused: false };
}

export async function handleSelectSession(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.agentStream || !h.getCdp()) return { success: false, error: 'AgentStream or CDP not available' };
    const sessionId = args?.targetSessionId || h.currentSession?.sessionId;
    if (!sessionId) return { success: false, error: 'targetSessionId required' };
    const ok = await h.agentStream.selectSession(h.getCdp()!, sessionId);
    return { success: ok };
}

export async function handleOpenPanel(h: CommandHelpers, args: any): Promise<CommandResult> {
    const cdp = h.getCdp();
    if (!cdp) return { success: false, error: 'AgentStream or CDP not available' };
    const sessionId = args?.targetSessionId || h.currentSession?.sessionId;
    if (!sessionId) return { success: false, error: 'targetSessionId required' };

    const currentTransport = h.currentSession?.transport;
    const shouldUseAgentStream = !!h.agentStream
        && currentTransport !== 'cdp-page'
        && currentTransport !== 'pty'
        && currentTransport !== 'acp';
    if (shouldUseAgentStream) {
        const ok = await h.agentStream.openSessionPanel(cdp, sessionId);
        return { success: ok };
    }

    const openResult = await executeProviderScript(h, args, 'openPanel');
    if (!openResult.success) return openResult;
    const revealState = normalizeOpenPanelCommandResult(openResult);

    let focusState = { focused: false };
    const focusResult = await executeProviderScript(h, args, 'focusEditor');
    if (focusResult.success) {
        focusState = normalizeFocusEditorCommandResult(focusResult);
    }

    return {
        ...openResult,
        ...(focusState.focused ? { focused: true } : {}),
        success: revealState.visible || focusState.focused,
    };
}

// ─── PTY Raw I/O ──────────────────────────────────

export async function handlePtyInput(h: CommandHelpers, args: any): Promise<CommandResult> {
    const { cliType, data, targetSessionId } = args || {};
    if (!data) return { success: false, error: 'data required' };

    // Filter out VT100/VT420 Device Attributes responses (e.g. \x1b[?1;2c or \x1b[>0;276;0c)
    // These are echoed by xterm.js in the dashboard in response to \x1b[c queries
    // and pollute the CLI input buffer.
    const cleanData = typeof data === 'string' ? data.replace(/\x1b\[[?>][0-9;]*c/g, '') : data;
    if (!cleanData) return { success: true };

    const adapter = h.getCliAdapter(targetSessionId || cliType);
    if (!adapter || typeof adapter.writeRaw !== 'function') {
        return { success: false, error: `CLI adapter not found: ${targetSessionId || cliType || 'unknown'}` };
    }
    await adapter.writeRaw(cleanData);
    return { success: true };
}

export function handlePtyResize(_h: CommandHelpers, args: any): CommandResult {
    const { cols, rows } = args || {};
    if (!cols || !rows) return { success: false, error: 'cols and rows required' };
    return { success: false, error: 'PTY resize temporarily disabled', code: 'PTY_RESIZE_DISABLED' };
}

interface TerminalSnapshotInstance extends ProviderInstance {
    getTerminalScreenSnapshot?(maxBytes?: number): {
        text: string;
        cursor: { col: number; row: number };
        cols: number;
        rows: number;
        truncated: boolean;
        originalBytes: number;
        returnedBytes: number;
        hash: string;
    } | null;
}

/**
 * MESH-READ-TERMINAL (feature 2: RAW terminal read). Reads the CURRENT rendered
 * PTY viewport of a specific mesh worker session for the mesh_read_terminal tool.
 *
 * This is the daemon-side `read_terminal` verb. It runs BOTH on the coordinator
 * (for a locally-hosted worker) and, after router forwarding
 * (MESH_FORWARDABLE_SESSION_COMMANDS + _meshDirectDispatch), on the OWNING remote
 * worker daemon — where the live viewport actually exists. The instance's
 * getTerminalScreenSnapshot() is gated on isMeshWorkerSession() (returns null for
 * a non-mesh session), which the MCP layer complements with a mesh/session/node
 * ownership cross-check. SECURITY: the raw viewport can contain tokens / args /
 * env / user data — never logged here (only its byte size / truncation flag are).
 */
export function handleReadTerminal(h: CommandHelpers, args: any): CommandResult {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const sessionId = targetSessionId || h.currentSession?.sessionId || '';
    if (!sessionId) return { success: false, error: 'targetSessionId required' };

    const session = h.ctx.sessionRegistry?.get(sessionId);
    const instanceKey = session?.adapterKey || session?.instanceKey || sessionId;
    const instance = h.ctx.instanceManager?.getInstance(instanceKey) as TerminalSnapshotInstance | undefined;
    if (!instance) return { success: false, error: `Session not found: ${sessionId.split('_')[0]}` };
    if (instance.category !== 'cli' || typeof instance.getTerminalScreenSnapshot !== 'function') {
        return { success: false, error: 'read_terminal is only supported for CLI (PTY) sessions' };
    }

    const requestedMaxBytes = typeof args?.maxBytes === 'number' && Number.isFinite(args.maxBytes)
        ? args.maxBytes
        : undefined;
    const snapshot = instance.getTerminalScreenSnapshot(requestedMaxBytes);
    if (!snapshot) {
        // getTerminalScreenSnapshot returns null when the session is NOT a mesh
        // worker — the raw-viewport read is scoped to coordinator-delegated workers.
        return { success: false, error: 'read_terminal is only available for coordinator-spawned mesh worker sessions' };
    }
    // Log size/truncation ONLY — never the screen text (may carry secrets).
    LOG.info('Command', `[readTerminal] session=${sessionId.split('_')[0]} bytes=${snapshot.returnedBytes}/${snapshot.originalBytes} truncated=${snapshot.truncated} cols=${snapshot.cols} rows=${snapshot.rows}`);
    return { success: true, ...snapshot };
}

interface KeyInjectableInstance extends ProviderInstance {
    injectKeys?(
        items: Array<{ text: string } | { key: string }>,
        opts?: { allowModalOverride?: boolean },
    ): Promise<
        | { ok: true; keys: string[]; hasDestructive: boolean; submits: boolean; bytes: number }
        | { ok: false; refused: string; keys: string[]; hasDestructive: boolean; message?: string }
    >;
}

/**
 * MESH-SEND-KEYS (feature 3: key injection). Inject a structured key sequence into
 * a specific mesh worker session's PTY for the mesh_send_keys tool.
 *
 * Daemon-side `send_keys` verb. Like read_terminal it runs on the coordinator for
 * a local worker and, after router forwarding (MESH_FORWARDABLE_SESSION_COMMANDS +
 * _meshDirectDispatch), on the OWNING remote worker daemon. The instance's
 * injectKeys() is gated on isMeshWorkerSession(); the MCP layer complements it with
 * mesh/session/node ownership + the destructive-key double gate (confirm_destructive
 * + mesh policy) + audit ledger.
 *
 * Defense-in-depth here: even though the MCP layer gates destructive keys, the
 * daemon re-enforces confirm_destructive so a direct/forwarded send_keys that
 * contains CTRL_C/ESC without confirm is refused at the boundary too.
 * SECURITY: never logs the literal text body (only key enums / byte counts).
 */
export async function handleSendKeys(h: CommandHelpers, args: any): Promise<CommandResult> {
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const sessionId = targetSessionId || h.currentSession?.sessionId || '';
    if (!sessionId) return { success: false, error: 'targetSessionId required' };

    const items = Array.isArray(args?.sequence) ? args.sequence : null;
    if (!items || items.length === 0) {
        return { success: false, error: 'sequence (non-empty array of {text}|{key}) required' };
    }

    const session = h.ctx.sessionRegistry?.get(sessionId);
    const instanceKey = session?.adapterKey || session?.instanceKey || sessionId;
    const instance = h.ctx.instanceManager?.getInstance(instanceKey) as KeyInjectableInstance | undefined;
    if (!instance) return { success: false, error: `Session not found: ${sessionId.split('_')[0]}` };
    if (instance.category !== 'cli' || typeof instance.injectKeys !== 'function') {
        return { success: false, error: 'send_keys is only supported for CLI (PTY) sessions' };
    }

    // Defense-in-depth destructive gate: refuse CTRL_C/ESC without confirm_destructive
    // even at the daemon boundary (the MCP layer is the primary gate + policy check).
    const DESTRUCTIVE = new Set(['CTRL_C', 'ESC']);
    const hasDestructiveRequested = items.some((it: any) => it && typeof it.key === 'string' && DESTRUCTIVE.has(it.key));
    if (hasDestructiveRequested && args?.confirm_destructive !== true) {
        return {
            success: false,
            error: 'destructive key (CTRL_C/ESC) requires confirm_destructive=true',
            refused: 'destructive_unconfirmed',
        };
    }

    try {
        const result = await instance.injectKeys(items, {
            allowModalOverride: args?.allow_modal_override === true,
        });
        if (!result.ok) {
            LOG.info('Command', `[sendKeys] session=${sessionId.split('_')[0]} refused=${result.refused} keys=${result.keys.join(',')} destructive=${result.hasDestructive}`);
            return { success: false, error: result.message ?? `send_keys refused: ${result.refused}`, refused: result.refused, keys: result.keys, hasDestructive: result.hasDestructive };
        }
        LOG.info('Command', `[sendKeys] session=${sessionId.split('_')[0]} injected keys=${result.keys.join(',') || '(text-only)'} bytes=${result.bytes} destructive=${result.hasDestructive} submits=${result.submits}`);
        return { success: true, keys: result.keys, hasDestructive: result.hasDestructive, submits: result.submits, bytes: result.bytes };
    } catch (e: any) {
        // Encode/validation errors (unknown key, over-limit) surface as a clean failure.
        return { success: false, error: `send_keys: ${e?.message || String(e)}` };
    }
}

// ─── Provider Settings ────────────────────────

export function handleGetProviderSettings(h: CommandHelpers, args: any): CommandResult {
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    const { providerType } = args || {};
    if (providerType) {
        const schema = loader?.getPublicSettings(providerType) || [];
        const values = loader?.getSettings(providerType) || {};
        return { success: true, providerType, schema, values };
    }
    const allSettings = loader?.getAllPublicSettings() || {};
    const allValues: Record<string, any> = {};
    for (const type of Object.keys(allSettings)) {
        allValues[type] = loader?.getSettings(type) || {};
    }
    return { success: true, settings: allSettings, values: allValues };
}

export async function handleSetProviderSetting(h: CommandHelpers, args: any): Promise<CommandResult> {
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    const { providerType, key, value } = args || {};
    if (!providerType || !key || value === undefined) {
        return { success: false, error: 'providerType, key, and value are required' };
    }
    const result = loader?.setSetting(providerType, key, value);
    if (result) {
        if (h.ctx.instanceManager) {
            const allSettings = loader?.getSettings(providerType) || {};
            const updated = h.ctx.instanceManager.updateInstanceSettings(providerType, allSettings);
            LOG.info('Command', `[set_provider_setting] ${providerType}.${key}=${JSON.stringify(value)} → ${updated} instance(s) updated`);
        }
        await h.ctx.onProviderSettingChanged?.(providerType, key, value);
        return { success: true, providerType, key, value };
    }
    return { success: false, error: `Failed to set ${providerType}.${key} — invalid key, value, or not a public setting` };
}

export function handleGetProviderSourceConfig(h: CommandHelpers, _args: any): CommandResult {
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    if (!loader) return { success: false, error: 'providerLoader not available' };
    return { success: true, ...loader.getSourceConfig() };
}

export async function handleSetProviderSourceConfig(h: CommandHelpers, args: any): Promise<CommandResult> {
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    if (!loader) return { success: false, error: 'providerLoader not available' };

    const parsed = parseProviderSourceConfigUpdate(args || {});
    if ('error' in parsed) {
        return { success: false, error: parsed.error };
    }

    const currentConfig = loadConfig();
    const nextConfig = {
        ...currentConfig,
        ...(parsed.updates.providerSourceMode ? { providerSourceMode: parsed.updates.providerSourceMode } : {}),
        ...(Object.prototype.hasOwnProperty.call(parsed.updates, 'providerDir') ? { providerDir: parsed.updates.providerDir } : {}),
    };
    saveConfig(nextConfig);

    const sourceConfig = loader.applySourceConfig({
        sourceMode: nextConfig.providerSourceMode,
        userDir: Object.prototype.hasOwnProperty.call(parsed.updates, 'providerDir') ? parsed.updates.providerDir : loader.getSourceConfig().explicitProviderDir || undefined,
    });
    loader.reload();
    loader.registerToDetector();
    const refreshedInstances = h.ctx.instanceManager
        ? h.ctx.instanceManager.refreshProviderDefinitions((providerType) => loader.resolve(providerType))
        : 0;
    await h.ctx.onProviderSourceConfigChanged?.();

    LOG.info(
        'Command',
        `[set_provider_source_config] mode=${sourceConfig.sourceMode} explicitProviderDir=${sourceConfig.explicitProviderDir || '-'} userDir=${sourceConfig.userDir}`,
    );

    return { success: true, reloaded: true, refreshedInstances, ...sourceConfig };
}

// ─── Extension Script Execution (Model/Mode) ─────

export function normalizeProviderScriptArgs(args: any, scriptName?: string): Record<string, any> {
    const normalizedArgs = { ...(args || {}) };
    const normalizedScriptName = String(scriptName || '').toLowerCase();

    if (Object.prototype.hasOwnProperty.call(normalizedArgs, 'value')) {
        if (
            normalizedArgs.model === undefined
            && (normalizedScriptName === 'setmodel' || normalizedScriptName === 'setmodelgui' || normalizedScriptName === 'webviewsetmodel')
        ) {
            normalizedArgs.model = normalizedArgs.value;
        }
        if (
            normalizedArgs.mode === undefined
            && (normalizedScriptName === 'setmode' || normalizedScriptName === 'webviewsetmode')
        ) {
            normalizedArgs.mode = normalizedArgs.value;
        }
    }

    for (const key of ['mode', 'model', 'message', 'action', 'button', 'text', 'sessionId', 'value']) {
        if (key in normalizedArgs && !(key.toUpperCase() in normalizedArgs)) {
            normalizedArgs[key.toUpperCase()] = normalizedArgs[key];
        }
    }
    return normalizedArgs;
}

function buildControlScriptResult(scriptName: string, payload: any): Record<string, unknown> {
    if (!payload || typeof payload !== 'object') return {};

    // The spec-driven control adapter (open_picker LIST/SELECT) already
    // produced a structured controlResult by parsing the live screen. Honour
    // it verbatim instead of re-deriving one from legacy payload shapes —
    // otherwise the screen-parsed options/currentValue get clobbered.
    if (payload.controlResult && typeof payload.controlResult === 'object') {
        return { controlResult: payload.controlResult };
    }

    const legacyListPayload = (() => {
        if (Array.isArray(payload.options)) return payload;
        if (/^listmodels$/i.test(scriptName) && Array.isArray(payload.models)) {
            return {
                options: payload.models,
                currentValue: payload.currentValue ?? payload.current ?? payload.currentModel,
                ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
            };
        }
        if (/^listmodes$/i.test(scriptName) && Array.isArray(payload.modes)) {
            return {
                options: payload.modes,
                currentValue: payload.currentValue ?? payload.current ?? payload.currentMode ?? payload.mode,
                ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
            };
        }
        return null;
    })();
    if (legacyListPayload) {
        return { controlResult: normalizeControlListResult(legacyListPayload) };
    }

    const legacyMutationPayload = (() => {
        if (typeof payload.ok === 'boolean') return payload;
        if (typeof payload.success === 'boolean') {
            return {
                ok: payload.success,
                currentValue: payload.currentValue
                    ?? payload.value
                    ?? payload.model
                    ?? payload.mode
                    ?? payload.selectedModel
                    ?? payload.selectedMode,
                ...(Array.isArray(payload.effects) ? { effects: payload.effects } : {}),
                ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
            };
        }
        return null;
    })();

    const looksLikeValueMutation = /^set|^change/i.test(scriptName)
        || payload.currentValue !== undefined
        || payload.value !== undefined
        || payload.success !== undefined;
    if (looksLikeValueMutation) {
        return { controlResult: normalizeControlSetResult(legacyMutationPayload || payload) };
    }
    if (payload.ok !== undefined || Array.isArray(payload.effects) || typeof payload.error === 'string') {
        return { controlResult: normalizeControlInvokeResult(legacyMutationPayload || payload) };
    }
    return {};
}

function applyProviderPatch(h: CommandHelpers, args: any, payload: any): void {
    if (!payload || typeof payload !== 'object') return;
    const targetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const targetSession = targetSessionId ? h.ctx.sessionRegistry?.get(targetSessionId) : undefined;
    const instanceKey = targetSession?.instanceKey || targetSessionId;
    if (!instanceKey) return;
    h.ctx.instanceManager?.sendEvent(instanceKey, 'provider_state_patch', {
        ...payload,
        extensionType: targetSession?.transport === 'cdp-webview' ? targetSession.providerType : undefined,
    });
}

async function executeProviderScript(h: CommandHelpers, args: any, scriptName: string): Promise<CommandResult> {
    const explicitTargetSessionId = typeof args?.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    const targetSession = explicitTargetSessionId ? h.ctx.sessionRegistry?.get(explicitTargetSessionId) : undefined;
    const resolvedProviderType =
        targetSession?.providerType
        || h.currentSession?.providerType
        || h.currentProviderType
        || args?.agentType
        || args?.providerType;
    if (!resolvedProviderType) return { success: false, error: 'targetSessionId or providerType is required' };

    const loader = h.ctx.providerLoader;
    if (!loader) return { success: false, error: 'ProviderLoader not initialized' };
    const provider = loader.resolve(resolvedProviderType);
    if (!provider) return { success: false, error: `Provider not found: ${resolvedProviderType}` };

    const webviewScriptName = `webview${scriptName.charAt(0).toUpperCase() + scriptName.slice(1)}`;
    const hasWebviewScript = provider.category === 'ide' &&
        !!provider.scripts?.[webviewScriptName];

    const actualScriptName = hasWebviewScript ? webviewScriptName : scriptName;

    if (!provider.scripts?.[actualScriptName as keyof typeof provider.scripts]) {
        return { success: false, error: `Script '${actualScriptName}' not available for ${resolvedProviderType}` };
    }

    const normalizedArgs = normalizeProviderScriptArgs(args, actualScriptName);

    if (provider.category === 'cli') {
        const adapter = h.getCliAdapter(args?.targetSessionId || resolvedProviderType);
        if (!adapter?.invokeScript) {
            return { success: false, error: `CLI adapter does not support script '${actualScriptName}'` };
        }
        try {
            const raw = await adapter.invokeScript(actualScriptName, normalizedArgs);
            const parsed = parseCliScriptResult(raw);
            if (!parsed.success) {
                return { success: false, ...(parsed.payload || {}) };
            }
            const cliCommand = getCliScriptCommand(parsed.payload);
            if (cliCommand?.type === 'send_message' && cliCommand.text) {
                await adapter.sendMessage(cliCommand.text);
            } else if (cliCommand?.type === 'pty_write' && cliCommand.text && adapter.writeRaw) {
                const enterCount = cliCommand.enterCount || 1;
                await adapter.writeRaw(cliCommand.text + '\r');
                for (let i = 1; i < enterCount; i += 1) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await adapter.writeRaw('\r');
                }
            }
            applyProviderPatch(h, args, parsed.payload);
            return {
                success: true,
                ...(parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : { result: parsed.payload }),
                ...buildControlScriptResult(scriptName, parsed.payload),
            };
        } catch (e: any) {
            return { success: false, error: `Script execution failed: ${e.message}` };
        }
    }

    const scriptFn = provider.scripts[actualScriptName as keyof typeof provider.scripts] as Function;
    const scriptCode = scriptFn(normalizedArgs);
    if (!scriptCode) return { success: false, error: `Script '${actualScriptName}' returned null` };

    const cdpKey = provider.category === 'ide'
        ? (targetSession?.cdpManagerKey || h.currentSession?.cdpManagerKey || h.currentManagerKey || resolvedProviderType)
        : (targetSession?.cdpManagerKey || h.currentSession?.cdpManagerKey || h.currentManagerKey);
    LOG.info('Command', `[ExtScript] provider=${provider.type} category=${provider.category} cdpKey=${cdpKey}`);
    const cdp = h.getCdp(cdpKey);
    if (!cdp?.isConnected) return { success: false, error: `No CDP connection for ${cdpKey || 'any'}` };

    try {
        let result: unknown;

        if (provider.category === 'extension') {
            const runtimeSessionId = explicitTargetSessionId || h.currentSession?.sessionId;
            if (!runtimeSessionId) return { success: false, error: `No target session found for ${resolvedProviderType}` };
            const parentSessionId = targetSession?.parentSessionId || h.currentSession?.parentSessionId;
            if (parentSessionId) {
                await h.agentStream?.setActiveSession(cdp, parentSessionId, runtimeSessionId);
                await h.agentStream?.syncActiveSession(cdp, parentSessionId);
            }
            const managed = runtimeSessionId ? h.agentStream?.getManagedSession(runtimeSessionId) : null;
            const targetSessionId = managed?.cdpSessionId || null;

            // IDE-level scripts (model/mode) — try session frame first, fallback to main page
            const DEFAULT_IDE_LEVEL_SCRIPTS = ['listModes', 'setMode', 'listModels', 'setModel'];
            const IDE_LEVEL_SCRIPTS = provider.ideLevelScripts ?? DEFAULT_IDE_LEVEL_SCRIPTS;
            if (IDE_LEVEL_SCRIPTS.includes(scriptName)) {
                // Try session frame first (some extensions embed mode selector in their webview)
                if (targetSessionId) {
                    try {
                        result = await cdp.evaluateInSessionFrame(targetSessionId, scriptCode);
                        // Check if result indicates "not found" — fallback to main page
                        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
                        const notFound = parsed?.error?.includes('not found') || parsed?.error?.includes('no root');
                        if (notFound) {
                            LOG.info('Command', `[ExtScript] ${scriptName} not found in session frame → trying IDE main page`);
                            result = await cdp.evaluate(scriptCode, 30000);
                        }
                    } catch {
                        LOG.info('Command', `[ExtScript] ${scriptName} session frame failed → trying IDE main page`);
                        result = await cdp.evaluate(scriptCode, 30000);
                    }
                } else {
                    LOG.info('Command', `[ExtScript] ${scriptName} no session → trying IDE main page`);
                    result = await cdp.evaluate(scriptCode, 30000);
                }
            } else {
                if (!targetSessionId) {
                    return { success: false, error: `No active session found for ${resolvedProviderType}` };
                }
                result = await cdp.evaluateInSessionFrame(targetSessionId, scriptCode);
            }
        } else if (hasWebviewScript && cdp.evaluateInWebviewFrame) {
            const matchText = provider.webviewMatchText;
            const matchFn = matchText ? (body: string) => body.includes(matchText) : undefined;
            result = await cdp.evaluateInWebviewFrame(scriptCode, matchFn);
        } else {
            result = await cdp.evaluate(scriptCode, 30000);
        }

        if (typeof result === 'string') {
            try {
                const parsed = JSON.parse(result);
                applyProviderPatch(h, args, parsed);
                if (parsed && typeof parsed === 'object' && parsed.success === false) {
                    return { success: false, ...parsed };
                }
                return { success: true, ...parsed, ...buildControlScriptResult(scriptName, parsed) };
            } catch {
                return { success: true, result };
            }
        }
        applyProviderPatch(h, args, result);
        return { success: true, result };
    } catch (e: any) {
        return { success: false, error: `Script execution failed: ${e.message}` };
    }
}

export async function handleExtensionScript(h: CommandHelpers, args: any, scriptName: string): Promise<CommandResult> {
    return executeProviderScript(h, args, scriptName);
}

export async function handleProviderScript(h: CommandHelpers, args: any): Promise<CommandResult> {
    const scriptName = typeof args?.scriptName === 'string' ? args.scriptName.trim() : '';
    if (!scriptName) return { success: false, error: 'scriptName is required' };
    return executeProviderScript(h, args, scriptName);
}

// ─── IDE Extension Settings (per-IDE on/off) ─────

export function handleGetIdeExtensions(h: CommandHelpers, args: any): CommandResult {
    const { ideType } = args || {};
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    if (!loader) return { success: false, error: 'ProviderLoader not initialized' };

    const allExtProviders = loader.getByCategory?.('extension') || [];

    if (ideType) {
        const extensions = allExtProviders.map(p => ({
            type: p.type,
            name: p.name,
            extensionId: p.extensionId,
            enabled: loader.getIdeExtensionEnabledState?.(ideType, p.type) === true,
        }));
        return { success: true, ideType, extensions };
    }

    const connectedIdes = [...(h.ctx.cdpManagers?.keys?.() || [])];
    const result: Record<string, any[]> = {};
    for (const ide of connectedIdes) {
        result[ide] = allExtProviders.map(p => ({
            type: p.type,
            name: p.name,
            extensionId: p.extensionId,
            enabled: loader.getIdeExtensionEnabledState?.(ide, p.type) === true,
        }));
    }
    return { success: true, ideExtensions: result };
}

export function handleSetIdeExtension(h: CommandHelpers, args: any): CommandResult {
    const { ideType, extensionType, enabled } = args || {};
    if (!ideType || !extensionType || enabled === undefined) {
        return { success: false, error: 'ideType, extensionType, and enabled are required' };
    }
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    if (!loader?.setIdeExtensionEnabled) {
        return { success: false, error: 'ProviderLoader not initialized' };
    }
    const ok = loader.setIdeExtensionEnabled(ideType, extensionType, !!enabled);
    if (ok) {
        return { success: true, ideType, extensionType, enabled: !!enabled };
    }
    return { success: false, error: 'Failed to save setting' };
}
