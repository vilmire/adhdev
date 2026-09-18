/**
 * Launch-argument expansion and CLI session binding resolution.
 *
 * Pure move out of cli-manager.ts (file-size gate headroom). Every function
 * below is byte-identical to the text it replaced; no behavior change. The
 * public names stay re-exported from cli-manager.ts, so existing import sites
 * are unaffected.
 *
 * Scope: deciding — from a provider's resume capability plus the argv it was
 * handed — whether a launch is `new`, `resume`, or `manual`, and what argv that
 * decision implies.
 */

import * as crypto from 'crypto';
import { stripRemovedSpawnArgs } from '../cli-adapters/provider-cli-runtime.js';
import type { ProviderModule, ProviderResumeCapability } from '../providers/contracts.js';
import { findProviderAutoApproveMode, resolveProviderAutoApproveMode } from '../providers/auto-approve-modes.js';

export type CliLaunchMode = 'new' | 'resume' | 'manual';

export type CliSessionBinding = {
    cliArgs?: string[];
    providerSessionId?: string;
    launchMode: CliLaunchMode;
};

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function readArgValue(args: string[], flags: string[]): string | undefined {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        for (const flag of flags) {
            if (arg === flag) {
                const next = args[index + 1];
                if (next && !next.startsWith('-')) return next;
            }
            const prefix = `${flag}=`;
            if (arg.startsWith(prefix)) return arg.slice(prefix.length);
        }
    }
    return undefined;
}

function hasArg(args: string[], flags: string[]): boolean {
    return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

/**
 * Expand a resume/new-session arg template, substituting `{{id}}` ANYWHERE in a
 * part rather than only when the part is exactly `{{id}}`.
 *
 * Most CLIs take the session id as its own argv entry (`--resume <id>`), which
 * the exact-match form handled. kimi does not: its own index keys sessions as
 * `session_<uuid>` and `kimi -S <bare-uuid>` answers `Session "<uuid>" not
 * found`, so the id it accepts is a PREFIXED string, not a bare one. Without
 * in-string substitution a provider whose CLI decorates the id cannot express
 * that in its spec at all, and the alternative — teaching daemon-core that kimi
 * ids need a `session_` prefix — would put one provider's argv quirk in shared
 * launch code.
 *
 * Substitution stays literal and non-recursive: every `{{id}}` occurrence in a
 * part is replaced with the id verbatim, and a part with no placeholder is
 * passed through untouched, so existing `["--resume", "{{id}}"]` templates
 * behave exactly as before.
 */
function expandResumeArgs(template: string[] | undefined, sessionId: string): string[] | undefined {
    if (!Array.isArray(template) || template.length === 0) return undefined;
    return template.map((part) => {
        if (!part.includes('{{id}}')) return part;
        // Idempotent against an id that ALREADY carries the decoration. Both
        // forms circulate for kimi — the executor extracts a bare uuid from the
        // directory name while a pin/`kimi -r` hint carries `session_<uuid>` —
        // and blindly templating a prefixed id would produce
        // `session_session_<uuid>`, a resume failure that looks exactly like the
        // bug this fix removes. Substituting the id's own decorated form keeps
        // the result identical whichever form arrives.
        const expanded = part.split('{{id}}').join(sessionId);
        const prefix = part.slice(0, part.indexOf('{{id}}'));
        if (prefix && sessionId.startsWith(prefix)) {
            return part.split('{{id}}').join(sessionId.slice(prefix.length));
        }
        return expanded;
    });
}

/**
 * Expand a provider's `thinkingLaunchArgs` template with the requested thinking
 * level, parallel to expandModelLaunchArgs. The standard level ('low'|'medium'|
 * 'high') is first mapped through the provider's `thinkingLevelMap` (a level absent
 * from the map passes through unchanged), then substituted into every `{{level}}`
 * token. Returns undefined when there is no template or no level (best-effort; a
 * thinking request without a template is a no-op). BRAIN-ROUTING thinking axis.
 */
export function expandThinkingLaunchArgs(
    template: string[] | undefined,
    level: string | undefined,
    levelMap: Partial<Record<string, string>> | undefined,
): string[] | undefined {
    const raw = typeof level === 'string' ? level.trim() : '';
    if (!raw || !Array.isArray(template) || template.length === 0) return undefined;
    const mapped = (levelMap && typeof levelMap[raw] === 'string' && levelMap[raw]!.trim()) ? levelMap[raw]!.trim() : raw;
    return template.map((part) => part.includes('{{level}}') ? part.replace('{{level}}', mapped) : part);
}

/**
 * Apply a selected launch-args auto-approve mode without mutating provider metadata.
 * removeArgs only targets provider-owned base spawn.args; launchArgs are prepended to
 * per-launch args beside model/thinking args, making conflict removal order-independent.
 *
 * PERMISSION-MODE-DUPLICATE: the resolved `removeArgs` are also RETURNED, because
 * filtering the manifest here only covers half the launch. Spec-backed CLIs (every
 * builtin since 48e5ed1a) spawn from the SPEC's `spawn_args`, a second base-arg source
 * this function cannot reach — see route.ts's `removeArgs` parameter, which carries the
 * list the rest of the way down to FsmDriver.
 */
export function applyAutoApproveModeLaunchArgs(
    provider: ProviderModule | undefined,
    cliArgs: string[] | undefined,
    settings: Record<string, unknown> | undefined,
): { provider: ProviderModule | undefined; cliArgs: string[] | undefined; removeArgs?: string[] } {
    if (!provider) return { provider, cliArgs };
    const resolved = resolveProviderAutoApproveMode(provider, settings);
    if (!resolved.active || resolved.strategy !== 'launch-args') return { provider, cliArgs };
    const mode = findProviderAutoApproveMode(provider, resolved.modeId);
    if (!mode || !Array.isArray(mode.launchArgs) || mode.launchArgs.length === 0) return { provider, cliArgs };

    const removeArgs = Array.isArray(mode.removeArgs) ? mode.removeArgs : [];
    const baseArgs = provider.spawn?.args;
    let filteredBaseArgs = baseArgs;
    if (Array.isArray(baseArgs) && removeArgs.length > 0) {
        const stripped = stripRemovedSpawnArgs(baseArgs, removeArgs);
        // Keep the array identity when nothing matched, so the provider object is
        // only cloned on a real change (the check below reads as a no-op guard).
        if (stripped.length !== baseArgs.length) filteredBaseArgs = stripped;
    }
    const launchProvider = filteredBaseArgs === baseArgs
        ? provider
        : { ...provider, spawn: { ...provider.spawn!, args: filteredBaseArgs } };
    return {
        provider: launchProvider,
        cliArgs: [...mode.launchArgs, ...(cliArgs || [])],
        removeArgs,
    };
}

function readSubcommandSessionId(args: string[], subcommands: string[]): string | undefined {
    const resumeIndex = args.findIndex((arg) => subcommands.includes(arg));
    if (resumeIndex < 0) return undefined;
    const candidate = args[resumeIndex + 1];
    if (!candidate || candidate.startsWith('-')) return undefined;
    return candidate;
}

function detectExplicitProviderSessionId(
    provider: ProviderModule | undefined,
    args: string[],
): { providerSessionId?: string; launchMode: CliLaunchMode } {
    const resume = provider?.resume;

    const explicitResumeId = readArgValue(args, ['--resume', '-r']);
    if (explicitResumeId) {
        return { providerSessionId: explicitResumeId, launchMode: 'resume' };
    }

    const explicitSessionFlagId = readArgValue(args, ['--session']);
    if (explicitSessionFlagId) {
        return {
            providerSessionId: explicitSessionFlagId,
            launchMode: 'resume',
        };
    }

    const explicitSessionId = readArgValue(args, ['--session-id']);
    if (explicitSessionId) {
        if (resume?.sessionIdIsNewByDefault && !hasArg(args, ['--resume', '-r'])) {
            return { launchMode: 'manual' };
        }
        const isResume = resume?.sessionIdIsNewByDefault
            ? hasArg(args, ['--resume', '-r'])
            : (hasArg(args, ['--continue']) || hasArg(args, ['--resume', '-r']));
        return {
            providerSessionId: explicitSessionId,
            launchMode: isResume ? 'resume' : 'new',
        };
    }

    const subcommands = resume?.sessionIdFromSubcommand;
    if (Array.isArray(subcommands) && subcommands.length > 0) {
        const hasResumeSubcommand = args.some((arg) => subcommands.includes(arg));
        const subcommandSessionId = readSubcommandSessionId(args, subcommands);
        if (subcommandSessionId) {
            return { providerSessionId: subcommandSessionId, launchMode: 'resume' };
        }
        if (hasResumeSubcommand) {
            return { launchMode: 'resume' };
        }
    }

    return { launchMode: 'manual' };
}

export function supportsExplicitSessionResume(resume?: ProviderResumeCapability): boolean {
    return !!(resume?.supported && Array.isArray(resume.resumeSessionArgs) && resume.resumeSessionArgs.length > 0);
}

function supportsExplicitSessionStart(resume?: ProviderResumeCapability): boolean {
    return !!(resume?.supported && Array.isArray(resume.newSessionArgs) && resume.newSessionArgs.length > 0);
}

export function resolveCliSessionBinding(
    provider: ProviderModule | undefined,
    normalizedType: string,
    cliArgs?: string[],
    requestedResumeSessionId?: string,
): CliSessionBinding {
    const baseArgs = Array.isArray(cliArgs) ? [...cliArgs] : undefined;
    const resume = provider?.resume;
    if (!resume?.supported) {
        return { cliArgs: baseArgs, launchMode: 'manual' };
    }

    const explicit = detectExplicitProviderSessionId(provider, baseArgs || []);
    if (explicit.providerSessionId) {
        return {
            cliArgs: baseArgs,
            providerSessionId: explicit.providerSessionId,
            launchMode: explicit.launchMode,
        };
    }
    if (explicit.launchMode === 'resume') {
        return {
            cliArgs: baseArgs,
            launchMode: 'resume',
        };
    }
    if (explicit.launchMode === 'manual' && hasArg(baseArgs || [], ['--session-id'])) {
        return {
            cliArgs: baseArgs,
            launchMode: 'manual',
        };
    }

    if (requestedResumeSessionId) {
        if (resume.sessionIdFormat === 'uuid' && !isUuid(requestedResumeSessionId)) {
            throw new Error(`Invalid ${provider?.displayName || provider?.name || normalizedType} session ID: ${requestedResumeSessionId}`);
        }
        const resumeSessionArgs = expandResumeArgs(resume.resumeSessionArgs, requestedResumeSessionId);
        if (!resumeSessionArgs) {
            return { cliArgs: baseArgs, launchMode: 'manual' };
        }
        return {
            cliArgs: [...(baseArgs || []), ...resumeSessionArgs],
            providerSessionId: requestedResumeSessionId,
            launchMode: 'resume',
        };
    }

    if (!supportsExplicitSessionStart(resume)) {
        return { cliArgs: baseArgs, launchMode: 'new' };
    }

    const providerSessionId = crypto.randomUUID();
    const newSessionArgs = expandResumeArgs(resume.newSessionArgs, providerSessionId);
    return {
        cliArgs: [...(baseArgs || []), ...(newSessionArgs || [])],
        providerSessionId,
        launchMode: 'new',
    };
}
