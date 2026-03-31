
/**
 * DashboardModelModeBar — Model/Mode selector for Dashboard tabs
 *
 * Extracted from Dashboard.tsx for maintainability.
 * Handles model/mode selection for IDE agents, extension agents, and ACP agents.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTransport } from '../../context/TransportContext';

// Module-level cache to preserve model/mode lists across tab switches
const _modelModeCache = new Map<string, { models: string[]; modes: string[] }>();

export interface ModelModeBarProps {
    ideId: string;
    sessionId?: string;
    ideType: string;
    providerType: string;
    displayLabel: string;
    /** Current model from daemon status report */
    serverModel?: string;
    /** Current mode from daemon status report */
    serverMode?: string;
    /** ACP config options (model, thought_level etc.) */
    acpConfigOptions?: { category: string; configId: string; currentValue?: string; options: { value: string; name: string; description?: string; group?: string }[] }[];
    /** ACP available modes */
    acpModes?: { id: string; name: string; description?: string }[];
}

export default function DashboardModelModeBar({ ideId, sessionId, ideType, providerType, displayLabel, serverModel, serverMode, acpConfigOptions, acpModes }: ModelModeBarProps) {
    const { sendCommand } = useTransport();
    const isAcp = !!(acpConfigOptions || acpModes);
    const cacheKey = `${ideId}:${sessionId || providerType}`;
    const cached = _modelModeCache.get(cacheKey);

    const [modelOpen, setModelOpen] = useState(false);
    const [modeOpen, setModeOpen] = useState(false);
    const [models, setModels] = useState<string[]>(cached?.models || []);
    const [modes, setModes] = useState<string[]>(cached?.modes || []);
    // Defensive: serverModel/serverMode may arrive as {name, id} objects from daemon status
    const toStr = (v: any): string => {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') return v.name || v.id || JSON.stringify(v);
        return String(v);
    };
    const [currentModel, setCurrentModel] = useState(toStr(serverModel));
    const [currentMode, setCurrentMode] = useState(toStr(serverMode));
    const [loadingModels, setLoadingModels] = useState(false);
    const [loadingModes, setLoadingModes] = useState(false);
    const localOverrideUntil = useRef<number>(0); // timestamp until which server updates are ignored

    // Normalize list items: providers may return [{name, id}] instead of string[]
    const normalizeList = (arr: any[]): string[] =>
        arr.map((item: any) => typeof item === 'string' ? item : (item?.name || item?.id || String(item)));

    // ACP: Auto-configure model list from acpConfigOptions
    useEffect(() => {
        if (acpConfigOptions) {
            const modelOpt = acpConfigOptions.find(c => c.category === 'model');
            if (modelOpt) {
                const list = normalizeList(modelOpt.options.map(o => o.value));
                setModels(list);
                if (modelOpt.currentValue) setCurrentModel(toStr(modelOpt.currentValue));
                const prev = _modelModeCache.get(cacheKey) || { models: [], modes: [] };
                _modelModeCache.set(cacheKey, { ...prev, models: list });
            }
        }
        if (acpModes && acpModes.length > 0) {
            const list = normalizeList(acpModes.map(m => m.id));
            setModes(list);
            const prev = _modelModeCache.get(cacheKey) || { models: [], modes: [] };
            _modelModeCache.set(cacheKey, { ...prev, modes: list });
        } else if (acpConfigOptions) {
            // If no ACP modes, use thought_level as mode
            const thoughtOpt = acpConfigOptions.find(c => c.category !== 'model');
            if (thoughtOpt) {
                const list = normalizeList(thoughtOpt.options.map(o => o.value));
                setModes(list);
                if (thoughtOpt.currentValue) setCurrentMode(toStr(thoughtOpt.currentValue));
                const prev = _modelModeCache.get(cacheKey) || { models: [], modes: [] };
                _modelModeCache.set(cacheKey, { ...prev, modes: list });
            }
        }
    }, [acpConfigOptions, acpModes, cacheKey]);

    // On tab switch: close dropdown, sync server values + restore cache
    useEffect(() => {
        setModelOpen(false); setModeOpen(false);
        // Always sync with server values (empty if none — prevent stale tab values)
        setCurrentModel(toStr(serverModel));
        setCurrentMode(toStr(serverMode));
        // Restore cached list
        const c = _modelModeCache.get(cacheKey);
        if (c) {
            setModels(c.models);
            setModes(c.modes);
        } else {
            setModels([]); setModes([]);
        }
    }, [ideId, providerType, sessionId]);

    // Reflect real-time server value updates (ignore for 5s after local changes)
    useEffect(() => {
        if (serverModel && Date.now() > localOverrideUntil.current) setCurrentModel(toStr(serverModel));
    }, [serverModel]);
    useEffect(() => {
        if (serverMode && Date.now() > localOverrideUntil.current) setCurrentMode(toStr(serverMode));
    }, [serverMode]);

    const exec = useCallback(async (cmd: string, data: Record<string, unknown> = {}) => {
        const enriched: Record<string, unknown> = {
            ...data,
            ...(sessionId && { targetSessionId: sessionId }),
        };
        return await sendCommand(ideId, cmd, enriched);
    }, [ideId, sessionId, sendCommand]);

    const fetchModels = async () => {
        if (models.length > 0) { setModelOpen(!modelOpen); return; }
        if (isAcp) { setModelOpen(true); return; } // ACP: already configured
        setLoadingModels(true);
        try {
            const res: any = await exec('list_extension_models', { agentType: providerType, ideType });
            const rawList = res?.models || res?.result?.models || [];
            const list = normalizeList(rawList);
            setModels(list);
            if (res?.current) setCurrentModel(toStr(res.current));
            if (res?.result?.current) setCurrentModel(toStr(res.result.current));
            // Save to cache (for tab switch restoration)
            const prev = _modelModeCache.get(cacheKey) || { models: [], modes: [] };
            _modelModeCache.set(cacheKey, { ...prev, models: list });
            setModelOpen(true);
        } catch { /* silent */ }
        finally { setLoadingModels(false); }
    };

    const fetchModes = async () => {
        if (modes.length > 0) { setModeOpen(!modeOpen); return; }
        if (isAcp) { setModeOpen(true); return; } // ACP: already configured
        setLoadingModes(true);
        try {
            const res: any = await exec('list_extension_modes', { agentType: providerType, ideType });
            const rawList = res?.modes || res?.result?.modes || [];
            const list = normalizeList(rawList);
            setModes(list);
            if (res?.current) setCurrentMode(toStr(res.current));
            if (res?.result?.current) setCurrentMode(toStr(res.result.current));
            // Save to cache (for tab switch restoration)
            const prev = _modelModeCache.get(cacheKey) || { models: [], modes: [] };
            _modelModeCache.set(cacheKey, { ...prev, modes: list });
            setModeOpen(true);
        } catch { /* silent */ }
        finally { setLoadingModes(false); }
    };

    const selectModel = async (model: string) => {
        setModelOpen(false);
        setCurrentModel(model);
        localOverrideUntil.current = Date.now() + 5000; // 5s ignore server values
        try {
            if (isAcp) {
                await exec('change_model', { agentType: providerType, ideType, model });
            } else {
                await exec('set_extension_model', { agentType: providerType, ideType, model });
            }
        } catch { /* silent */ }
    };

    // If ACP has no modes but has thought_level configOption, change thought_level
    const isThoughtLevel = isAcp && !(acpModes && acpModes.length > 0) && acpConfigOptions?.some(c => c.category !== 'model');
    const thoughtConfigId = isThoughtLevel ? acpConfigOptions?.find(c => c.category !== 'model')?.configId : undefined;

    const selectMode = async (mode: string) => {
        setModeOpen(false);
        setCurrentMode(mode);
        localOverrideUntil.current = Date.now() + 5000;
        try {
            if (isAcp && isThoughtLevel && thoughtConfigId) {
                // thought_level → change via set_config_option
                await exec('set_thought_level', { agentType: providerType, ideType, configId: thoughtConfigId, value: mode });
            } else if (isAcp) {
                await exec('set_mode', { agentType: providerType, ideType, mode });
            } else {
                await exec('set_extension_mode', { agentType: providerType, ideType, mode });
            }
        } catch { /* silent */ }
    };

    const AGENT_COLORS: Record<string, string> = {
        'cline': '#22d3ee', 'roo-code': '#a78bfa', 'cursor': '#60a5fa',
        'antigravity': '#f97316', 'windsurf': '#34d399',
    };
    const accent = AGENT_COLORS[providerType] || '#94a3b8';

    return (
        <div className="flex items-center gap-1.5 px-3 py-1 flex-wrap text-[10px] border-t border-border-subtle bg-[var(--surface-primary)]">
            <span
                className="text-[9px] font-bold tracking-wide uppercase opacity-70"
                style={{ color: accent }}
            >
                {displayLabel}
            </span>
            <span className="text-border-subtle text-[10px]">│</span>

            {/* Model chip */}
            <div className="relative">
                <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all bg-[var(--surface-tertiary)] whitespace-nowrap max-w-40 overflow-hidden text-ellipsis"
                    style={{
                        borderColor: modelOpen ? `${accent}55` : 'transparent',
                        border: '1px solid',
                        color: currentModel ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                    onClick={fetchModels}
                >
                    <span className="text-[9px] opacity-60">🤖</span>
                    {loadingModels ? '...' : currentModel || 'Model'}
                    <span className="text-[7px] opacity-50">▼</span>
                </span>
                {modelOpen && models.length > 0 && (
                    <>
                        <div className="fixed inset-0 z-[59]" onClick={() => setModelOpen(false)} />
                        <div className="absolute bottom-full left-0 z-[60] bg-[var(--surface-primary)] border border-border-subtle rounded-lg mb-1 max-h-[220px] overflow-y-auto min-w-40 shadow-[0_-4px_16px_rgba(0,0,0,0.3)]">
                            <div className="px-3 py-1.5 text-[9px] font-bold text-text-muted tracking-wider border-b border-border-subtle">
                                SELECT MODEL
                            </div>
                            {models.map(m => (
                                <div
                                    key={m}
                                    className="px-3 py-[7px] text-[11px] cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis"
                                    style={{
                                        background: m === currentModel ? `${accent}18` : 'transparent',
                                        color: m === currentModel ? accent : 'var(--text-secondary)',
                                        fontWeight: m === currentModel ? 600 : 400,
                                        borderLeft: m === currentModel ? `2px solid ${accent}` : '2px solid transparent',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = `${accent}12`; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = m === currentModel ? `${accent}18` : 'transparent'; }}
                                    onClick={() => selectModel(m)}
                                >{m}</div>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {/* Mode chip */}
            <div className="relative">
                <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all bg-[var(--surface-tertiary)] whitespace-nowrap max-w-40 overflow-hidden text-ellipsis"
                    style={{
                        borderColor: modeOpen ? `${accent}55` : 'transparent',
                        border: '1px solid',
                        color: currentMode ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                    onClick={fetchModes}
                >
                    <span className="text-[9px] opacity-60">{isThoughtLevel ? '🧠' : '⚡'}</span>
                    {loadingModes ? '...' : currentMode || (isThoughtLevel ? 'Thinking' : 'Mode')}
                    <span className="text-[7px] opacity-50">▼</span>
                </span>
                {modeOpen && modes.length > 0 && (
                    <>
                        <div className="fixed inset-0 z-[59]" onClick={() => setModeOpen(false)} />
                        <div className="absolute bottom-full left-0 z-[60] bg-[var(--surface-primary)] border border-border-subtle rounded-lg mb-1 max-h-[220px] overflow-y-auto min-w-40 shadow-[0_-4px_16px_rgba(0,0,0,0.3)]">
                            <div className="px-3 py-1.5 text-[9px] font-bold text-text-muted tracking-wider border-b border-border-subtle">
                                {isThoughtLevel ? 'SELECT THINKING LEVEL' : 'SELECT MODE'}
                            </div>
                            {modes.map(m => (
                                <div
                                    key={m}
                                    className="px-3 py-[7px] text-[11px] cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis"
                                    style={{
                                        background: m === currentMode ? `${accent}18` : 'transparent',
                                        color: m === currentMode ? accent : 'var(--text-secondary)',
                                        fontWeight: m === currentMode ? 600 : 400,
                                        borderLeft: m === currentMode ? `2px solid ${accent}` : '2px solid transparent',
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = `${accent}12`; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = m === currentMode ? `${accent}18` : 'transparent'; }}
                                    onClick={() => selectMode(m)}
                                >{m}</div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
