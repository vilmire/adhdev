/**
 * Provider settings and controls contracts: the settings a provider declares for
 * the settings page, and the interactive chat-panel controls (select / toggle /
 * cycle / slider / action / display) with their list / set / invoke results.
 * ProviderControlSchema (shared-types.ts) is the serialized ProviderControlDef.
 */
import type { ProviderEffect } from './contracts.js';

// ─── Provider Settings ─────────────────────────────────

/** Setting variable definition declared by provider */
export interface ProviderSettingDef {
  type: 'boolean' | 'number' | 'string' | 'select';
  default: any;
 /** true = controllable from dashboard UI */
  public: boolean;
 /** UI label */
  label?: string;
 /** UI description */
  description?: string;
 /** Minimum value for number type */
  min?: number;
 /** Maximum value for number type */
  max?: number;
 /** Options for select type */
  options?: string[];
}

/** Public settings schema (for dashboard transmission) */
export interface ProviderSettingSchema extends ProviderSettingDef {
  key: string;
}

// ─── Provider Controls (interactive chat-level controls) ────────

/**
 * Control types:
 * - 'select'  — dropdown list (model picker, mode picker)
 * - 'toggle'  — on/off switch (compact mode, auto-approve)
 * - 'cycle'   — click-to-cycle through options (thinking level: low→med→high)
 * - 'slider'  — numeric range (temperature: 0–2)
 * - 'action'  — one-shot button (show usage, restart, clear context)
 */
export type ProviderControlType = 'select' | 'toggle' | 'cycle' | 'slider' | 'action' | 'display';

/**
 * Where the control appears in the chat UI:
 * - 'bar'    — thin strip below/above the chat input (always visible)
 * - 'header' — in the agent header area
 * - 'menu'   — inside a ⋯ overflow menu
 */
export type ProviderControlPlacement = 'bar' | 'header' | 'menu';

/** Static option for select/cycle controls */
export interface ProviderControlOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

export interface ControlListResult {
  options: ProviderControlOption[];
  currentValue?: string | number | boolean;
  error?: string;
}

export interface ControlSetResult {
  ok: boolean;
  currentValue?: string | number | boolean;
  effects?: ProviderEffect[];
  error?: string;
}

export interface ControlInvokeResult {
  ok: boolean;
  currentValue?: string | number | boolean;
  effects?: ProviderEffect[];
  error?: string;
}

/**
 * ProviderControlDef — A single interactive control declared by a provider.
 *
 * Controls are different from Settings:
 * - Settings: background config, infrequently changed, managed in settings page
 * - Controls: interactive, changed during chat, rendered inside chat panel
 *
 * Each control maps to provider scripts for get/set operations.
 * The frontend renders controls automatically based on this schema —
 * no hardcoded model/mode assumptions needed.
 *
 * For 'action' type:
 * - Renders as a button. On click → calls invokeScript.
 * - No value state. Optionally shows result via toast/inline.
 */
export interface ProviderControlDef {
 /** Unique identifier (e.g. 'model', 'mode', 'thinking', 'usage') */
  id: string;
 /** Control type */
  type: ProviderControlType;
 /** Display label */
  label: string;
 /** Icon (emoji or icon name) */
  icon?: string;
 /** Where to show this control in the UI */
  placement: ProviderControlPlacement;

 // ─── Options (for select/cycle) ───
 /** Static options — used when the list is known at definition time */
  options?: ProviderControlOption[];
 /** Dynamic options — load via script at runtime */
  dynamic?: boolean;
 /** Script name to list options (e.g. 'listModels') — required when dynamic=true */
  listScript?: string;

 // ─── Value (for select/toggle/cycle/slider) ───
 /** Script name to change value (e.g. 'setModel') — required for value-based controls */
  setScript?: string;
 /** Field name in readChat() result to read current value (e.g. 'model', 'mode') */
  readFrom?: string;
 /** Default value */
  defaultValue?: string | number | boolean;

 // ─── Action (for 'action' type) ───
 /** Script name to invoke (one-shot call, no value) */
  invokeScript?: string;
 /** How to display action result: 'toast' = notification, 'inline' = show in bar, 'none' = silent */
  resultDisplay?: 'toast' | 'inline' | 'none';
 /** Optional confirmation title shown before invoking a destructive or disruptive action */
  confirmTitle?: string;
 /** Optional confirmation message shown before invoking a destructive or disruptive action */
  confirmMessage?: string;
 /** Optional confirmation button label */
  confirmLabel?: string;

 // ─── Slider-specific ───
  min?: number;
  max?: number;
  step?: number;

 // ─── Display ───
 /** Sort order within placement group (lower = first) */
  order?: number;
 /** Hide this control when condition not met */
  hidden?: boolean;
 /**
  * FSM state ids in which this control should be visible (mirrors the spec's
  * `control_bar[].visible_when_state`). When omitted the control is always
  * visible. The daemon enforces this on click (FsmDriver.handleClickControl),
  * so the web bar must mirror the same gating to avoid showing a button that
  * the daemon would silently drop. Uses raw FSM state ids (e.g. 'idle',
  * 'busy'), not the derived dashboard status.
  */
  visibleWhenState?: string[];
}
