
/**
 * ControlsBar — Dynamic provider controls rendered from schema
 *
 * Providers must declare typed bar controls. If no bar controls are declared,
 * this component renders nothing instead of falling back to legacy model/mode heuristics.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
    ControlInvokeResult,
    ControlListResult,
    ControlSetResult,
    ProviderControlSchema,
} from '@adhdev/daemon-core';
import { useTransport } from '../../context/TransportContext';
import { eventManager } from '../../managers/EventManager';

// Module-level cache for dynamic options (persists across tab switches)
const _optionsCache = new Map<string, Record<string, ControlOption[]>>();

type ControlScalarValue = string | number | boolean;
type ControlMutationResult = ControlSetResult | ControlInvokeResult;
type ControlOption = ControlListResult['options'][number];
type ControlEffect = {
    type: 'toast' | 'notification' | string;
    toast?: { message: string; level?: 'info' | 'success' | 'warning' };
    notification?: { body: string; level?: 'info' | 'success' | 'warning' };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isControlScalarValue(value: unknown): value is ControlScalarValue {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function extractControlListResult(response: unknown): ControlListResult | null {
    if (!isRecord(response) || !isRecord(response.controlResult) || !Array.isArray(response.controlResult.options)) {
        return null;
    }
    return response.controlResult as unknown as ControlListResult;
}

export function extractControlMutationResult(response: unknown): ControlMutationResult | null {
    if (!isRecord(response) || !isRecord(response.controlResult) || typeof response.controlResult.ok !== 'boolean') {
        return null;
    }
    return response.controlResult as unknown as ControlMutationResult;
}

function getResponseError(response: unknown): string | undefined {
    if (!isRecord(response) || typeof response.error !== 'string' || !response.error.trim()) return undefined;
    return response.error;
}

function isExplicitFailure(response: unknown): boolean {
    return isRecord(response) && response.success === false;
}

function applyControlEffects(effects: ControlEffect[] | undefined): void {
    for (const effect of effects || []) {
        if (effect.type === 'toast' && effect.toast?.message) {
            const level = effect.toast.level === 'warning'
                ? 'warning'
                : effect.toast.level === 'success'
                    ? 'success'
                    : 'info';
            eventManager.showToast(effect.toast.message, level);
            continue;
        }
        if (effect.type === 'notification' && effect.notification?.body) {
            const level = effect.notification.level === 'warning'
                ? 'warning'
                : effect.notification.level === 'success'
                    ? 'success'
                    : 'info';
            eventManager.showToast(effect.notification.body, level);
        }
    }
}

function getMutationValue(result: ControlMutationResult | null, optimisticValue: ControlScalarValue): ControlScalarValue {
    return result && isControlScalarValue(result.currentValue) ? result.currentValue : optimisticValue;
}

function getControlOptions(
    ctrl: ProviderControlSchema,
    dynamicOptions: Record<string, ControlOption[]>,
): ControlOption[] {
    return ctrl.options || dynamicOptions[ctrl.id] || [];
}

const HIDE_NEW_SESSION_BAR_PROVIDERS = new Set([
    'antigravity',
    'claude-code-vscode',
    'codex',
]);

export function shouldHideBarControl(
    hostIdeType: string | undefined,
    providerType: string,
    ctrl: ProviderControlSchema,
): boolean {
    void hostIdeType;
    return ctrl.id === 'new_session' && HIDE_NEW_SESSION_BAR_PROVIDERS.has(providerType);
}

export function buildControlValueScriptArgs(
    _ctrl: ProviderControlSchema,
    value: ControlScalarValue,
): Record<string, ControlScalarValue> {
    return { value };
}

function getControlValueLabel(
    ctrl: ProviderControlSchema,
    dynamicOptions: Record<string, ControlOption[]>,
    value: string,
): string {
    if (!value) return '';
    const options = getControlOptions(ctrl, dynamicOptions);
    return options.find(option => option.value === value)?.label || value;
}

export interface ControlsBarProps {
    routeId: string;
    sessionId?: string;
    hostIdeType?: string;
    providerType: string;
    displayLabel: string;
    controls?: ProviderControlSchema[];
    controlValues?: Record<string, string | number | boolean>;
}

const AGENT_COLORS: Record<string, string> = {
    'cline': '#22d3ee', 'roo-code': '#a78bfa', 'cursor': '#60a5fa',
    'claude-code-vscode': '#ea580c', 'codex': '#10b981',
    'antigravity': '#f97316', 'windsurf': '#34d399',
};

export default function ControlsBar({
    routeId, sessionId, hostIdeType, providerType, displayLabel,
    controls, controlValues,
}: ControlsBarProps) {
    const { sendCommand } = useTransport();
    const cacheKey = `${routeId}:${sessionId || providerType}`;
    const accent = AGENT_COLORS[providerType] || '#94a3b8';

    // Local state for optimistic updates
    const [localValues, setLocalValues] = useState<Record<string, string | number | boolean>>({});
    const localOverrideUntil = useRef<number>(0);
    const defaultValues: Record<string, string | number | boolean> = {};
    for (const ctrl of controls || []) {
        if (ctrl.defaultValue !== undefined) {
            defaultValues[ctrl.id] = ctrl.defaultValue;
        }
    }

    // Merge server values with local overrides
    const effectiveValues: Record<string, string | number | boolean> = {
        ...defaultValues,
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
    const [dynamicOptions, setDynamicOptions] = useState<Record<string, ControlOption[]>>(
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
    ) => {
        const scope = sessionId
            ? { targetSessionId: sessionId }
            : { agentType: providerType, ...(hostIdeType ? { ideType: hostIdeType } : {}) };
        return await exec('invoke_provider_script', {
            ...scope,
            scriptName,
            ...payload,
        });
    }, [exec, providerType, hostIdeType, sessionId]);

    const commitMutationResult = useCallback((
        ctrl: ProviderControlSchema,
        optimisticValue: ControlScalarValue,
        result: ControlMutationResult | null,
    ) => {
        const nextValue = getMutationValue(result, optimisticValue);
        setLocalValues(prev => ({ ...prev, [ctrl.id]: nextValue }));
        applyControlEffects(result?.effects as ControlEffect[] | undefined);
    }, []);

    const rollbackControlValue = useCallback((ctrl: ProviderControlSchema, previousValue: ControlScalarValue | undefined) => {
        setLocalValues(prev => {
            const next = { ...prev };
            if (previousValue === undefined) {
                delete next[ctrl.id];
            } else {
                next[ctrl.id] = previousValue;
            }
            return next;
        });
        localOverrideUntil.current = 0;
    }, []);

    if (!controls || controls.length === 0) {
        return null;
    }

    const barControls = controls
        .filter(c => c.placement === 'bar' && c.hidden !== true && !shouldHideBarControl(hostIdeType, providerType, c))
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

    if (barControls.length === 0) {
        return null;
    }

    const handleSelectToggle = async (ctrl: ProviderControlSchema) => {
        if (openDropdown === ctrl.id) {
            setOpenDropdown(null);
            return;
        }

        const existing = getControlOptions(ctrl, dynamicOptions);
        if (existing.length > 0) {
            setOpenDropdown(ctrl.id);
            return;
        }

        if (ctrl.dynamic && ctrl.listScript) {
            setLoadingOption(ctrl.id);
            try {
                const res = await invokeProviderScript(ctrl.listScript, {});
                const controlResult = extractControlListResult(res);
                if (!controlResult) {
                    const errorMessage = getResponseError(res);
                    if (errorMessage) eventManager.showToast(errorMessage, 'warning');
                    return;
                }
                const options = controlResult.options;
                setDynamicOptions(prev => {
                    const next = { ...prev, [ctrl.id]: options };
                    _optionsCache.set(cacheKey, next);
                    return next;
                });
                if (isControlScalarValue(controlResult.currentValue)) {
                    const currentValue = controlResult.currentValue;
                    setLocalValues(prev => ({ ...prev, [ctrl.id]: currentValue }));
                }
                setOpenDropdown(ctrl.id);
            } catch (error) {
                const message = error instanceof Error ? error.message : `Could not load ${ctrl.label}`;
                eventManager.showToast(message, 'warning');
            } finally {
                setLoadingOption(null);
            }
        }
    };

    const handleSelectValue = async (ctrl: ProviderControlSchema, value: string) => {
        setOpenDropdown(null);
        const previousValue = controlValues?.[ctrl.id] ?? defaultValues[ctrl.id];
        setLocalValues(prev => ({ ...prev, [ctrl.id]: value }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            const res = await invokeProviderScript(ctrl.setScript, buildControlValueScriptArgs(ctrl, value));
            const mutationResult = extractControlMutationResult(res);
            if ((mutationResult && !mutationResult.ok) || isExplicitFailure(res)) {
                throw new Error(mutationResult?.error || getResponseError(res) || `Could not update ${ctrl.label}`);
            }
            commitMutationResult(ctrl, value, mutationResult);
        } catch (error) {
            rollbackControlValue(ctrl, previousValue);
            const message = error instanceof Error ? error.message : `Could not update ${ctrl.label}`;
            eventManager.showToast(message, 'warning');
        }
    };

    const handleCycleValue = async (ctrl: ProviderControlSchema) => {
        const options = getControlOptions(ctrl, dynamicOptions).map(option => option.value);
        if (options.length === 0) return;
        const current = String(effectiveValues[ctrl.id] || '');
        const currentIdx = options.indexOf(current);
        const nextIdx = (currentIdx + 1) % options.length;
        const nextValue = options[nextIdx];
        if (typeof nextValue !== 'string') return;

        const previousValue = controlValues?.[ctrl.id] ?? defaultValues[ctrl.id];
        setLocalValues(prev => ({ ...prev, [ctrl.id]: nextValue }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            const res = await invokeProviderScript(ctrl.setScript, buildControlValueScriptArgs(ctrl, nextValue));
            const mutationResult = extractControlMutationResult(res);
            if ((mutationResult && !mutationResult.ok) || isExplicitFailure(res)) {
                throw new Error(mutationResult?.error || getResponseError(res) || `Could not update ${ctrl.label}`);
            }
            commitMutationResult(ctrl, nextValue, mutationResult);
        } catch (error) {
            rollbackControlValue(ctrl, previousValue);
            const message = error instanceof Error ? error.message : `Could not update ${ctrl.label}`;
            eventManager.showToast(message, 'warning');
        }
    };

    const handleToggleValue = async (ctrl: ProviderControlSchema) => {
        const current = effectiveValues[ctrl.id];
        const nextValue = !current;
        const previousValue = controlValues?.[ctrl.id] ?? defaultValues[ctrl.id];

        setLocalValues(prev => ({ ...prev, [ctrl.id]: nextValue }));
        localOverrideUntil.current = Date.now() + 5000;

        try {
            if (!ctrl.setScript) return;
            const res = await invokeProviderScript(ctrl.setScript, buildControlValueScriptArgs(ctrl, nextValue));
            const mutationResult = extractControlMutationResult(res);
            if ((mutationResult && !mutationResult.ok) || isExplicitFailure(res)) {
                throw new Error(mutationResult?.error || getResponseError(res) || `Could not update ${ctrl.label}`);
            }
            commitMutationResult(ctrl, nextValue, mutationResult);
        } catch (error) {
            rollbackControlValue(ctrl, previousValue);
            const message = error instanceof Error ? error.message : `Could not update ${ctrl.label}`;
            eventManager.showToast(message, 'warning');
        }
    };

    const handleActionClick = async (ctrl: ProviderControlSchema) => {
        if (!ctrl.invokeScript) return;
        if (ctrl.confirmMessage) {
            const confirmLines = [ctrl.confirmTitle, ctrl.confirmMessage, ctrl.confirmLabel]
                .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
            const confirmed = window.confirm(confirmLines.join('\n\n'));
            if (!confirmed) return;
        }
        const previousValue = controlValues?.[ctrl.id] ?? defaultValues[ctrl.id];
        try {
            const res = await invokeProviderScript(ctrl.invokeScript);
            const mutationResult = extractControlMutationResult(res);
            if ((mutationResult && !mutationResult.ok) || isExplicitFailure(res)) {
                throw new Error(mutationResult?.error || getResponseError(res) || `Could not run ${ctrl.label}`);
            }
            if (mutationResult) {
                commitMutationResult(ctrl, previousValue ?? true, mutationResult);
            }
        } catch (error) {
            rollbackControlValue(ctrl, previousValue);
            const message = error instanceof Error ? error.message : `Could not run ${ctrl.label}`;
            eventManager.showToast(message, 'warning');
        }
    };

    return (
        <div className="flex items-center gap-1.5 px-3 py-1 flex-wrap text-[10px] border-t border-border-subtle bg-surface-primary font-[var(--font)]">
            <span className="text-[9px] font-bold tracking-wide opacity-70" style={{ color: accent }}>
                {displayLabel}
            </span>
            <span className="text-border-subtle text-[10px]">│</span>

            {barControls.map(ctrl => {
                const currentValue = String(effectiveValues[ctrl.id] || '');
                const currentLabel = getControlValueLabel(ctrl, dynamicOptions, currentValue);
                const isOpen = openDropdown === ctrl.id;
                const isLoading = loadingOption === ctrl.id;
                const options = getControlOptions(ctrl, dynamicOptions);

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
                                    {isLoading ? '...' : currentLabel || ctrl.label}
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
                                                    key={opt.value}
                                                    className="px-3 py-[7px] text-[11px] cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis"
                                                    style={{
                                                        background: opt.value === currentValue ? `${accent}18` : 'transparent',
                                                        color: opt.value === currentValue ? accent : 'var(--text-secondary)',
                                                        fontWeight: opt.value === currentValue ? 600 : 400,
                                                        borderLeft: opt.value === currentValue ? `2px solid ${accent}` : '2px solid transparent',
                                                    }}
                                                    title={opt.description || opt.label}
                                                    onMouseEnter={e => { e.currentTarget.style.background = `${accent}12`; }}
                                                    onMouseLeave={e => { e.currentTarget.style.background = opt.value === currentValue ? `${accent}18` : 'transparent'; }}
                                                    onClick={() => handleSelectValue(ctrl, opt.value)}
                                                >{opt.label}</div>
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
                                title={`Click to cycle: ${options.map(option => option.label).join(' → ')}`}
                            >
                                {ctrl.icon && <span className="text-[9px] opacity-60">{ctrl.icon}</span>}
                                {currentLabel || ctrl.label}
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
