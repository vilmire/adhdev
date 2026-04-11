
/**
 * ControlsBar — Dynamic provider controls rendered from schema
 *
 * Replaces ModelModeBar with a generic, schema-driven approach.
 * Each provider declares its controls (model, mode, thinking, temperature, etc.)
 * and this component renders the appropriate UI for each.
 *
 * Falls back to legacy ModelModeBar when providerControls schema is absent.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTransport } from '../../context/TransportContext';
import DashboardModelModeBar from './ModelModeBar';
// Inline type (mirrors ProviderControlSchema from @adhdev/daemon-core/shared-types)
// Avoids build dependency on daemon-core re-export timing
interface ProviderControlSchema {
    id: string;
    type: 'select' | 'toggle' | 'cycle' | 'slider' | 'action' | 'display';
    label: string;
    icon?: string;
    placement: 'bar' | 'header' | 'menu';
    options?: { value: string; label: string; description?: string; group?: string }[];
    dynamic?: boolean;
    listScript?: string;
    setScript?: string;
    readFrom?: string;
    defaultValue?: string | number | boolean;
    invokeScript?: string;
    resultDisplay?: 'toast' | 'inline' | 'none';
    min?: number;
    max?: number;
    step?: number;
    order?: number;
}

// Module-level cache for dynamic options (persists across tab switches)
const _optionsCache = new Map<string, Record<string, string[]>>();

export interface ControlsBarProps {
    routeId: string;
    sessionId?: string;
    hostIdeType?: string;
    providerType: string;
    displayLabel: string;
    /** Provider-declared controls schema */
    controls?: ProviderControlSchema[];
    /** Current control values from daemon status */
    controlValues?: Record<string, string | number | boolean>;
    /** Legacy compatibility values while providers finish migrating to schema controls */
    serverModel?: string;
    serverMode?: string;
    /** ACP config options (backward compat) */
    acpConfigOptions?: any[];
    /** ACP modes (backward compat) */
    acpModes?: any[];
}

const AGENT_COLORS: Record<string, string> = {
    'cline': '#22d3ee', 'roo-code': '#a78bfa', 'cursor': '#60a5fa',
    'antigravity': '#f97316', 'windsurf': '#34d399',
};

export default function ControlsBar({
    routeId, sessionId, hostIdeType, providerType, displayLabel,
    controls, controlValues, serverModel, serverMode, acpConfigOptions, acpModes,
}: ControlsBarProps) {
    const { sendCommand } = useTransport();
    const cacheKey = `${routeId}:${sessionId || providerType}`;
    const accent = AGENT_COLORS[providerType] || '#94a3b8';

    // Local state for optimistic updates
    const [localValues, setLocalValues] = useState<Record<string, string | number | boolean>>({});
    const localOverrideUntil = useRef<number>(0);

    // Merge server values with local overrides
    const effectiveValues: Record<string, string | number | boolean> = {
        ...(serverModel ? { model: serverModel } : {}),
        ...(serverMode ? { mode: serverMode } : {}),
        ...(controlValues || {}),
        ...(Date.now() < localOverrideUntil.current ? localValues : {}),
    };

    // Sync from server when not in local override window
    useEffect(() => {
        if (controlValues && Date.now() > localOverrideUntil.current) {
            setLocalValues({});
        }
    }, [controlValues]);

    // Dynamic options state
    const [dynamicOptions, setDynamicOptions] = useState<Record<string, string[]>>(
        _optionsCache.get(cacheKey) || {}
    );
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    const [loadingOption, setLoadingOption] = useState<string | null>(null);

    const exec = useCallback(async (cmd: string, data: Record<string, unknown> = {}) => {
        const enriched: Record<string, unknown> = {
            ...data,
            ...(sessionId && { targetSessionId: sessionId }),
        };
        return await sendCommand(routeId, cmd, enriched);
    }, [routeId, sessionId, sendCommand]);

    const invokeProviderScript = useCallback(async (
        scriptName: string,
        payload: Record<string, unknown> = {},
        fallbackCmd?: string,
    ) => {
        const scope = sessionId
            ? { targetSessionId: sessionId }
            : { agentType: providerType, ...(hostIdeType ? { ideType: hostIdeType } : {}) };
        try {
            const res = await exec('invoke_provider_script', {
                ...scope,
                scriptName,
                ...payload,
            });
            if (res?.success === false && fallbackCmd) {
                return await exec(fallbackCmd, {
                    ...scope,
                    ...payload,
                });
            }
            return res;
        } catch (error) {
            if (!fallbackCmd) throw error;
            return await exec(fallbackCmd, {
                ...scope,
                ...payload,
            });
        }
    }, [exec, providerType, hostIdeType]);

    if (!controls || controls.length === 0) {
        return (
            <DashboardModelModeBar
                routeId={routeId}
                sessionId={sessionId}
                hostIdeType={hostIdeType}
                providerType={providerType}
                displayLabel={displayLabel}
                serverModel={serverModel}
                serverMode={serverMode}
                acpConfigOptions={acpConfigOptions}
                acpModes={acpModes}
            />
        );
    }

    const barControls = controls
        .filter(c => c.placement === 'bar')
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

    if (barControls.length === 0) {
        return (
            <DashboardModelModeBar
                routeId={routeId}
                sessionId={sessionId}
                hostIdeType={hostIdeType}
                providerType={providerType}
                displayLabel={displayLabel}
                serverModel={serverModel}
                serverMode={serverMode}
                acpConfigOptions={acpConfigOptions}
                acpModes={acpModes}
            />
        );
    }

    const handleSelectToggle = async (ctrl: ProviderControlSchema) => {
        if (openDropdown === ctrl.id) {
            setOpenDropdown(null);
            return;
        }

        // If we already have options, just open
        const existing = ctrl.options?.map(o => o.value) || dynamicOptions[ctrl.id] || [];
        if (existing.length > 0) {
            setOpenDropdown(ctrl.id);
            return;
        }

        // Dynamic: fetch options via listScript
        if (ctrl.dynamic && ctrl.listScript) {
            setLoadingOption(ctrl.id);
            try {
                const fallbackCmd = mapLegacyScriptCommand(ctrl.listScript);
                const res: any = await invokeProviderScript(ctrl.listScript, {}, fallbackCmd);
                const rawList = res?.models || res?.modes || res?.result?.models || res?.result?.modes || res?.options || [];
                const list = rawList.map((item: any) =>
                    typeof item === 'string' ? item : (item?.name || item?.id || item?.value || String(item))
                );
                setDynamicOptions(prev => {
                    const next = { ...prev, [ctrl.id]: list };
                    _optionsCache.set(cacheKey, next);
                    return next;
                });
                setOpenDropdown(ctrl.id);
            } catch { /* silent */ }
            finally { setLoadingOption(null); }
        }
    };

    const handleSelectValue = async (ctrl: ProviderControlSchema, value: string) => {
        setOpenDropdown(null);
        setLocalValues(prev => ({ ...prev, [ctrl.id]: value }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            await invokeProviderScript(ctrl.setScript, {
                model: ctrl.id === 'model' ? value : undefined,
                mode: ctrl.id === 'mode' ? value : undefined,
                value,
            }, mapLegacyScriptCommand(ctrl.setScript));
        } catch { /* silent */ }
    };

    const handleCycleValue = async (ctrl: ProviderControlSchema) => {
        const options = ctrl.options?.map(o => o.value) || dynamicOptions[ctrl.id] || [];
        if (options.length === 0) return;
        const current = String(effectiveValues[ctrl.id] || '');
        const currentIdx = options.indexOf(current);
        const nextIdx = (currentIdx + 1) % options.length;
        const nextValue = options[nextIdx];
        if (typeof nextValue !== 'string') return;

        setLocalValues(prev => ({ ...prev, [ctrl.id]: nextValue }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            await invokeProviderScript(ctrl.setScript, { value: nextValue }, mapLegacyScriptCommand(ctrl.setScript));
        } catch { /* silent */ }
    };

    const handleToggleValue = async (ctrl: ProviderControlSchema) => {
        const current = effectiveValues[ctrl.id];
        const nextValue = !current;

        setLocalValues(prev => ({ ...prev, [ctrl.id]: nextValue }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            await invokeProviderScript(ctrl.setScript, { value: nextValue }, mapLegacyScriptCommand(ctrl.setScript));
        } catch { /* silent */ }
    };

    const handleActionClick = async (ctrl: ProviderControlSchema) => {
        if (!ctrl.invokeScript) return;
        try {
            await invokeProviderScript(ctrl.invokeScript);
        } catch { /* silent */ }
    };

    return (
        <div className="flex items-center gap-1.5 px-3 py-1 flex-wrap text-[10px] border-t border-border-subtle bg-surface-primary font-[var(--font)]">
            <span className="text-[9px] font-bold tracking-wide opacity-70" style={{ color: accent }}>
                {displayLabel}
            </span>
            <span className="text-border-subtle text-[10px]">│</span>

            {barControls.map(ctrl => {
                const currentValue = String(effectiveValues[ctrl.id] || '');
                const isOpen = openDropdown === ctrl.id;
                const isLoading = loadingOption === ctrl.id;
                const options = ctrl.options?.map(o => o.value)
                    || dynamicOptions[ctrl.id]
                    || [];

                switch (ctrl.type) {
                    case 'select':
                        return (
                            <div key={ctrl.id} className="relative">
                                <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all bg-[var(--surface-tertiary)] whitespace-nowrap max-w-40 overflow-hidden text-ellipsis"
                                    style={{
                                        borderColor: isOpen ? `${accent}55` : 'transparent',
                                        border: '1px solid',
                                        color: currentValue ? 'var(--text-primary)' : 'var(--text-muted)',
                                    }}
                                    onClick={() => handleSelectToggle(ctrl)}
                                >
                                    {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                    {isLoading ? '...' : currentValue || ctrl.label}
                                    <span className="text-[7px] opacity-50">▼</span>
                                </span>
                                {isOpen && options.length > 0 && (
                                    <>
                                        <div className="fixed inset-0 z-[59]" onClick={() => setOpenDropdown(null)} />
                                        <div className="absolute bottom-full left-0 z-[60] bg-[var(--surface-primary)] border border-border-subtle rounded-lg mb-1 max-h-[220px] overflow-y-auto min-w-40 shadow-[0_-4px_16px_rgba(0,0,0,0.3)]">
                                            <div className="px-3 py-1.5 text-[9px] font-bold text-text-muted tracking-wider border-b border-border-subtle">
                                                {ctrl.label.toUpperCase()}
                                            </div>
                                            {options.map(opt => (
                                                <div
                                                    key={opt}
                                                    className="px-3 py-[7px] text-[11px] cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis"
                                                    style={{
                                                        background: opt === currentValue ? `${accent}18` : 'transparent',
                                                        color: opt === currentValue ? accent : 'var(--text-secondary)',
                                                        fontWeight: opt === currentValue ? 600 : 400,
                                                        borderLeft: opt === currentValue ? `2px solid ${accent}` : '2px solid transparent',
                                                    }}
                                                    onMouseEnter={e => { e.currentTarget.style.background = `${accent}12`; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = opt === currentValue ? `${accent}18` : 'transparent'; }}
                                                    onClick={() => handleSelectValue(ctrl, opt)}
                                                >{opt}</div>
                                            ))}
                                        </div>
                                    </>
                                )}
                            </div>
                        );

                    case 'cycle':
                        return (
                            <span
                                key={ctrl.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all bg-[var(--surface-tertiary)] whitespace-nowrap"
                                style={{
                                    border: '1px solid transparent',
                                    color: currentValue ? 'var(--text-primary)' : 'var(--text-muted)',
                                }}
                                onClick={() => handleCycleValue(ctrl)}
                                title={`Click to cycle: ${options.join(' → ')}`}
                            >
                                {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                {currentValue || ctrl.label}
                                <span className="text-[7px] opacity-50">⟳</span>
                            </span>
                        );

                    case 'toggle':
                        return (
                            <span
                                key={ctrl.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all whitespace-nowrap"
                                style={{
                                    border: '1px solid',
                                    borderColor: currentValue ? `${accent}44` : 'transparent',
                                    background: currentValue ? `${accent}14` : 'var(--surface-tertiary)',
                                    color: currentValue ? accent : 'var(--text-muted)',
                                }}
                                onClick={() => handleToggleValue(ctrl)}
                            >
                                {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                {ctrl.label}
                            </span>
                        );

                    case 'action':
                        return (
                            <span
                                key={ctrl.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium cursor-pointer transition-all hover:bg-[var(--surface-tertiary-hover)] whitespace-nowrap"
                                style={{
                                    border: '1px solid var(--border-default)',
                                    background: 'var(--surface-tertiary)',
                                    color: 'var(--text-primary)',
                                }}
                                onClick={() => handleActionClick(ctrl)}
                            >
                                {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                {ctrl.resultDisplay === 'inline' && currentValue
                                    ? `${ctrl.label}: ${currentValue}`
                                    : ctrl.label}
                            </span>
                        );

                    case 'display':
                        return (
                            <span
                                key={ctrl.id}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xl text-[10px] font-medium whitespace-nowrap"
                                style={{
                                    border: '1px solid var(--border-default)',
                                    background: 'var(--surface-tertiary)',
                                    color: currentValue ? 'var(--text-primary)' : 'var(--text-muted)',
                                }}
                            >
                                {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                {currentValue ? `${ctrl.label}: ${currentValue}` : ctrl.label}
                            </span>
                        );

                    default:
                        return null;
                }
            })}
        </div>
    );
}

// ─── Helpers ────────────────────────────────────────────

/**
 * Legacy daemon commands kept as fallback while providers migrate to generic invoke_provider_script.
 */
function mapLegacyScriptCommand(setScript: string): string | undefined {
    const mapping: Record<string, string> = {
        'setModel': 'set_extension_model',
        'setMode': 'set_extension_mode',
        'listModels': 'list_extension_models',
        'listModes': 'list_extension_modes',
        'setThinkingLevel': 'set_thought_level',
    };
    return mapping[setScript];
}
