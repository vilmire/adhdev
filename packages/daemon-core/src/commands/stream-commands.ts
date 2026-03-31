/**
 * Stream Commands — Agent Stream, PTY I/O, Provider Settings,
 *                   IDE Extension Settings, Extension Script Execution
 */

import type { CommandResult, CommandHelpers } from './handler.js';
import type { ProviderLoader } from '../providers/provider-loader.js';
import { loadConfig } from '../config/config.js';
import { LOG } from '../logging/logger.js';

export async function handleFocusSession(h: CommandHelpers, args: any): Promise<CommandResult> {
    if (!h.agentStream || !h.getCdp()) return { success: false, error: 'AgentStream or CDP not available' };
    const sessionId = args?.targetSessionId || h.currentSession?.sessionId;
    if (!sessionId) return { success: false, error: 'targetSessionId required' };
    const ok = await h.agentStream.focusSession(h.getCdp()!, sessionId);
    return { success: ok };
}

// ─── PTY Raw I/O ──────────────────────────────────

export function handlePtyInput(h: CommandHelpers, args: any): CommandResult {
    const { cliType, data, targetSessionId } = args || {};
    if (!data) return { success: false, error: 'data required' };
    const adapter = h.getCliAdapter(targetSessionId || cliType);
    if (!adapter || typeof adapter.writeRaw !== 'function') {
        return { success: false, error: `CLI adapter not found: ${targetSessionId || cliType || 'unknown'}` };
    }
    adapter.writeRaw(data);
    return { success: true };
}

export function handlePtyResize(h: CommandHelpers, args: any): CommandResult {
    const { cliType, cols, rows, force, targetSessionId } = args || {};
    if (!cols || !rows) return { success: false, error: 'cols and rows required' };
    const adapter = h.getCliAdapter(targetSessionId || cliType);
    if (!adapter || typeof adapter.resize !== 'function') {
        return { success: false, error: `CLI adapter not found: ${targetSessionId || cliType || 'unknown'}` };
    }
    if (force) {
        adapter.resize(cols - 1, rows);
        setTimeout(() => adapter.resize(cols, rows), 50);
    } else {
        adapter.resize(cols, rows);
    }
    return { success: true };
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

export function handleSetProviderSetting(h: CommandHelpers, args: any): CommandResult {
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
        return { success: true, providerType, key, value };
    }
    return { success: false, error: `Failed to set ${providerType}.${key} — invalid key, value, or not a public setting` };
}

// ─── Extension Script Execution (Model/Mode) ─────

export async function handleExtensionScript(h: CommandHelpers, args: any, scriptName: string): Promise<CommandResult> {
    const { agentType, ideType } = args || {};
    LOG.info('Command', `[ExtScript] ${scriptName} agentType=${agentType} ideType=${ideType} session=${h.currentSession?.sessionId || ''}`);
    if (!agentType) return { success: false, error: 'agentType is required' };

    const loader = h.ctx.providerLoader;
    if (!loader) return { success: false, error: 'ProviderLoader not initialized' };
    const provider = loader.resolve(agentType);
    if (!provider) return { success: false, error: `Provider not found: ${agentType}` };

    const webviewScriptName = `webview${scriptName.charAt(0).toUpperCase() + scriptName.slice(1)}`;
    const hasWebviewScript = provider.category === 'ide' &&
        !!provider.scripts?.[webviewScriptName];

    const actualScriptName = hasWebviewScript ? webviewScriptName : scriptName;

    if (!provider.scripts?.[actualScriptName as keyof typeof provider.scripts]) {
        return { success: false, error: `Script '${actualScriptName}' not available for ${agentType}` };
    }

    const scriptFn = provider.scripts[actualScriptName as keyof typeof provider.scripts] as Function;
    // Normalize args: script placeholders use UPPERCASE (${MODE}, ${MODEL}, ${MESSAGE})
    // but WebSocket args typically use lowercase. Add uppercase versions of common keys.
    const normalizedArgs = { ...args };
    for (const key of ['mode', 'model', 'message', 'action', 'button', 'text', 'sessionId']) {
        if (key in normalizedArgs && !(key.toUpperCase() in normalizedArgs)) {
            normalizedArgs[key.toUpperCase()] = normalizedArgs[key];
        }
    }
    const scriptCode = scriptFn(normalizedArgs);
    if (!scriptCode) return { success: false, error: `Script '${actualScriptName}' returned null` };

    const cdpKey = provider.category === 'ide'
        ? (h.currentSession?.cdpManagerKey || h.currentManagerKey || agentType)
        : (h.currentSession?.cdpManagerKey || h.currentManagerKey || ideType);
    LOG.info('Command', `[ExtScript] provider=${provider.type} category=${provider.category} cdpKey=${cdpKey}`);
    const cdp = h.getCdp(cdpKey);
    if (!cdp?.isConnected) return { success: false, error: `No CDP connection for ${cdpKey || 'any'}` };

    try {
        let result: unknown;

        if (provider.category === 'extension') {
            const runtimeSessionId = h.currentSession?.sessionId || args?.targetSessionId;
            if (!runtimeSessionId) return { success: false, error: `No target session found for ${agentType}` };
            const parentSessionId = h.currentSession?.parentSessionId;
            if (parentSessionId) {
                await h.agentStream?.setActiveSession(cdp, parentSessionId, runtimeSessionId);
                await h.agentStream?.syncActiveSession(cdp, parentSessionId);
            }
            const managed = runtimeSessionId ? h.agentStream?.getManagedSession(runtimeSessionId) : null;
            const targetSessionId = managed?.cdpSessionId || null;

            // IDE-level scripts (model/mode) — try session frame first, fallback to main page
            const IDE_LEVEL_SCRIPTS = ['listModes', 'setMode', 'listModels', 'setModel'];
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
                    return { success: false, error: `No active session found for ${agentType}` };
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
                return { success: true, ...parsed };
            } catch {
                return { success: true, result };
            }
        }
        return { success: true, result };
    } catch (e: any) {
        return { success: false, error: `Script execution failed: ${e.message}` };
    }
}

// ─── IDE Extension Settings (per-IDE on/off) ─────

export function handleGetIdeExtensions(h: CommandHelpers, args: any): CommandResult {
    const { ideType } = args || {};
    const loader = h.ctx.providerLoader as ProviderLoader | undefined;
    if (!loader) return { success: false, error: 'ProviderLoader not initialized' };

    const allExtProviders = loader.getByCategory?.('extension') || [];
    const config = loadConfig();

    if (ideType) {
        const extensions = allExtProviders.map(p => ({
            type: p.type,
            name: p.name,
            extensionId: p.extensionId,
            enabled: config.ideSettings?.[ideType]?.extensions?.[p.type]?.enabled === true,
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
            enabled: config.ideSettings?.[ide]?.extensions?.[p.type]?.enabled === true,
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
