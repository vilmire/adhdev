/**
 * Pure helpers extracted from provider-loader.ts (pure move, 2026-09-18).
 *
 * Everything here was a `private` method or module function on / beside
 * ProviderLoader that touched no instance state. Moving them out is behavior-
 * preserving by construction: each body is byte-identical to the original,
 * with only the declaration line changed from a class member to an exported
 * function. ProviderLoader re-exports nothing from here — it imports and
 * delegates, so its public API is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  ProviderControlDef,
  ProviderModule,
  ProviderScripts,
  ProviderSettingDef,
} from './contracts.js';

/**
 * Adds a provider-script root to the require whitelist. Wrapped in a
 * try/catch + null check so a loader hot-path can't crash on a path
 * that doesn't exist yet or one the whitelist hook rejects.
 *
 * The require-whitelist module is loaded lazily on first call. Eagerly
 * top-level importing it pulls `node:fs.realpathSync.native` into
 * module evaluation, which breaks unit tests that partially mock `fs`
 * (e.g. test/commands/get-logs-incremental.test.ts mocks only
 * existsSync + readFileSync). Lazy load keeps that mock surface valid.
 */
export function registerProviderScriptRootSafely(root: string | null | undefined): void {
  if (!root || typeof root !== 'string') return;
  try {
    const { registerProviderScriptRoot } =
      require('./sdk/v1/sandbox/require-whitelist.js') as typeof import('./sdk/v1/sandbox/require-whitelist.js');
    registerProviderScriptRoot(root);
  } catch { /* boot-time only — swallow */ }
}

/**
 * Translate a spec `control_bar` array into the web-facing
 * `ProviderControlDef[]` shape the dashboard renders.
 *
 * The two shapes are distinct: `control_bar` entries are daemon-side
 * `{ id, label, visible_when_state, action }` records driving
 * SpecCliAdapter.invokeScript, while the dashboard's chat bar reads
 * `ProviderControlDef` (`{ id, type, label, placement, ... }`). Spec
 * providers (claude-cli / codex-cli) historically declared *only*
 * `control_bar`, so the dashboard saw no controls at all — the Model / Mode
 * pickers never rendered. This bridges that gap without changing how the
 * controls actually dispatch.
 *
 * Script-name contract: the dashboard sends the control's
 * `listScript` / `setScript` / `invokeScript` name through
 * `invoke_provider_script`, which gates on `provider.scripts[<name>]` and then
 * routes to `SpecCliAdapter.invokeScript(<name>)` — which matches the name
 * against `control_bar[].id`. So every synthesized script name MUST equal the
 * control id (the loader stubs `provider.scripts[id]` from the same source).
 *
 * Mapping:
 *   open_picker  → select (dynamic): list + set both keyed on the control id;
 *                  the adapter distinguishes LIST vs SELECT by the presence of
 *                  a choice arg, so one id serves both roles.
 *   send_keys    → action: one-shot keystroke (stop, cycle_mode).
 *   attach_image → skipped: it needs an image blob from a file picker, not a
 *                  bare bar button; surfacing it as an `action` would only
 *                  produce a button that errors with "requires args.blob".
 */
export function synthesizeControlsFromControlBar(specControls: any[]): ProviderControlDef[] {
  const out: ProviderControlDef[] = [];
  specControls.forEach((ctl, index) => {
    const id = typeof ctl?.id === 'string' ? ctl.id.trim() : '';
    const actionType = ctl?.action?.type;
    if (!id || !actionType) return;
    const label = typeof ctl?.label === 'string' && ctl.label.trim() ? ctl.label : id;
    // Preserve the spec's state gating so the web bar can mirror the daemon's
    // FsmDriver.handleClickControl enforcement (otherwise the button renders in
    // states where the daemon would silently drop the click).
    const visibleWhenState = Array.isArray(ctl?.visible_when_state)
      ? ctl.visible_when_state.filter((s: unknown): s is string => typeof s === 'string')
      : undefined;
    if (actionType === 'open_picker') {
      out.push({
        id,
        type: 'select',
        label,
        placement: 'bar',
        dynamic: true,
        listScript: id,
        setScript: id,
        readFrom: id,
        order: index,
        ...(visibleWhenState && visibleWhenState.length > 0 ? { visibleWhenState } : {}),
      });
    } else if (actionType === 'send_keys') {
      out.push({
        id,
        type: 'action',
        label,
        placement: 'bar',
        invokeScript: id,
        resultDisplay: 'none',
        order: index,
        ...(visibleWhenState && visibleWhenState.length > 0 ? { visibleWhenState } : {}),
      });
    }
    // attach_image intentionally skipped — see fn doc.
  });
  return out;
}

/**
 * Build a scripts function map from individual .js files in a directory.
 * Each file is wrapped as: (params?) => fs.readFileSync(filePath, 'utf-8')
 * (template substitution is NOT applied here — scripts.js handles that)
 */
export function buildScriptWrappersFromDir(dir: string): Partial<ProviderScripts> {
  // Use a dedicated scripts.js in the alt dir if present
  const scriptsJs = path.join(dir, 'scripts.js');
  if (fs.existsSync(scriptsJs)) {
    try {
      delete require.cache[require.resolve(scriptsJs)];
      return require(scriptsJs);
    } catch { /* fall through to individual file loading */ }
  }

  // Individual files: list_models.js → scripts.listModels, etc.
  const toCamel = (name: string) =>
    name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

  const result: Partial<ProviderScripts> = {};
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const scriptName = toCamel(file.replace('.js', ''));
      const filePath = path.join(dir, file);
      result[scriptName] = (...args: any[]): string => {
        try {
          let content = fs.readFileSync(filePath, 'utf-8');
          if (args[0] && typeof args[0] === 'object') {
            for (const [key, val] of Object.entries(args[0])) {
              let v = val;
              if (typeof v === 'string') {
                // If it doesn't start with a quote, user probably passed raw text
                if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
                  v = JSON.stringify(v);
                }
              } else {
                v = JSON.stringify(v);
              }
              const re = new RegExp(`\\$\\{\\s*${key}\\s*\\}`, 'g');
              content = content.replace(re, String(v));
            }
          } else if (typeof args[0] === 'string') {
            // Fallback for single-string arg passed as firstVal
            const re = new RegExp(`\\$\\{\\s*MESSAGE\\s*\\}`, 'g');
            let v = args[0];
            if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
              v = JSON.stringify(v);
            }
            content = content.replace(re, String(v));
          } else if (args[0] !== undefined) {
             // legacy fallback for single argument usually MESSAGE
             let v = String(args[0]);
             if (!v.startsWith('"') && !v.startsWith("'") && !v.startsWith('`')) {
                 v = JSON.stringify(v);
             }
             content = content.replace(new RegExp(`\\$\\{\\s*MESSAGE\\s*\\}`, 'g'), v);
          }
          return content;
        } catch { return ''; }
      };
    }
  } catch { /* ignore */ }
  return result;
}

export function parseArgsSetting(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaping = false;
  for (const ch of value.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote === 'single') {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === 'double') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += '\\';
  if (current) args.push(current);
  return args;
}

export function getPlatformVersionCommand(versionCommand?: ProviderModule['versionCommand']): string | undefined {
  if (!versionCommand) return undefined;
  if (typeof versionCommand === 'string') {
    const trimmed = versionCommand.trim();
    return trimmed || undefined;
  }
  const platformValue = versionCommand[process.platform];
  if (typeof platformValue === 'string' && platformValue.trim()) {
    return platformValue.trim();
  }
  const defaultValue = versionCommand.default;
  if (typeof defaultValue === 'string' && defaultValue.trim()) {
    return defaultValue.trim();
  }
  return undefined;
}

export function getSyntheticSettings(type: string, provider: ProviderModule): Record<string, ProviderSettingDef> {
  const result: Record<string, ProviderSettingDef> = {};

  if (provider.category === 'cli' || provider.category === 'acp') {
    result.enabled = {
      type: 'boolean',
      default: false,
      public: true,
      label: 'Enabled on this machine',
      description: 'Opt in before ADHDev detects, launches, or verifies this provider on this machine.',
    };
  }

  if (!provider.settings?.autoApprove) {
    result.autoApprove = {
      type: 'boolean',
      // (fix) Safe default is *off*. Auto-approving every modal without the
      // user opting in produced silent-bash-execution surprises and the
      // "Auto-approved: ..." system-message flood seen on AGY/Codex.
      default: false,
      public: true,
      label: 'Auto Approve',
      description: 'Automatically approve actionable prompts without sending approval alerts.',
    };
  }

  if ((provider.category === 'cli' || provider.category === 'acp') && provider.spawn?.command && !provider.settings?.executablePath) {
    result.executablePath = {
      type: 'string',
      default: '',
      public: true,
      label: 'Executable path',
      description: 'Optional absolute path for this provider binary. Leave blank to use the default PATH lookup.',
    };
  }

  if ((provider.category === 'cli' || provider.category === 'acp') && provider.spawn?.command && !provider.settings?.executableArgs) {
    result.executableArgs = {
      type: 'string',
      default: '',
      public: true,
      label: 'Executable arguments',
      description: 'Optional replacement for provider default command arguments. Leave blank to use the provider default.',
    };
  }

  if (provider.category === 'ide') {
    if (provider.cli && !provider.settings?.cliPathOverride) {
      result.cliPathOverride = {
        type: 'string',
        default: '',
        public: true,
        label: 'CLI path override',
        description: 'Optional absolute path for the IDE CLI launcher. Leave blank to use the detected default.',
      };
    }
    if (provider.paths && !provider.settings?.appPathOverride) {
      result.appPathOverride = {
        type: 'string',
        default: '',
        public: true,
        label: 'App path override',
        description: 'Optional absolute path for the IDE app bundle or executable. Leave blank to use the default install locations.',
      };
    }
  }

  return result;
}

 /**
 * Simple semver range matching
 * Supported formats: '>=4.0.0', '<3.0.0', '>=2.1.0'
 */
export function matchesVersion(current: string, range: string): boolean {
  const match = range.match(/^([><=!]+)\s*(\d+\.\d+\.\d+)$/);
  if (!match) return false;

  const [, op, target] = match;
  const cmp = compareVersions(current, target);

  switch (op) {
    case '>=': return cmp >= 0;
    case '>': return cmp > 0;
    case '<=': return cmp <= 0;
    case '<': return cmp < 0;
    case '=':
    case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    default: return false;
  }
}

export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.split(/[-_+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
  const pa = normalize(a);
  const pb = normalize(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
