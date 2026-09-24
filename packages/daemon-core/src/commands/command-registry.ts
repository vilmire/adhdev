/**
 * Command registry — the ONE place a daemon command's name, handler and
 * routing attributes live.
 *
 * Before this module the same command names were repeated across nine
 * independent tables (router chat list, mesh-forwardable set, invalidation
 * table + mesh-graph predicate, cloud mandatory-update block list, standalone
 * sessionId alias list, handler session-scoped + CDP lists, cloud launch
 * fast-flush predicate, git command allow-list) and four dispatch layers (three
 * family Maps + the handler switch). Each of those facts is now an attribute on
 * the command's {@link CommandSpec}, declared next to the handler, and the
 * router dispatches by `registry.get(cmd)`.
 *
 * This module is a dependency leaf on purpose (type-only imports): family
 * handler files call {@link defineCommandSpecs} while they are being
 * evaluated, which must not depend on the evaluation order of the command
 * modules' import cycle through router.ts.
 */
import type { TransportTopic } from '../shared-types.js';
import type { CommandRouterResult } from './router.js';
import type { LowFamilyContext } from './low-family/types.js';
import type { MedFamilyContext } from './med-family/types.js';
import type { HighFamilyContext } from './high-family/types.js';
import type { DaemonCommandHandler } from './handler.js';
import type { GitCommandServices } from '../git/git-commands.js';
import type { MeshSenderClass } from './mesh-sender.js';

/** Where a command entered the daemon. Recorded verbatim in the command log. */
export type CommandSource = 'ws' | 'p2p' | 'ext' | 'api' | 'standalone' | 'ipc' | 'mesh' | 'internal';

export const COMMAND_SOURCES: readonly CommandSource[] = ['ws', 'p2p', 'ext', 'api', 'standalone', 'ipc', 'mesh', 'internal'];

export function isCommandSource(source: unknown): source is CommandSource {
    return typeof source === 'string' && (COMMAND_SOURCES as readonly string[]).includes(source);
}

/** The command-log source for a caller-supplied source string; anything else is `unknown`. */
export function normalizeCommandSource(source: unknown): CommandSource | 'unknown' {
    return isCommandSource(source) ? source : 'unknown';
}

/**
 * Subset of transport topics that command execution can invalidate (forcing
 * an immediate dashboard flush instead of waiting for the heartbeat).
 */
export type CommandInvalidationTopic = Extract<
    TransportTopic,
    'daemon.metadata' | 'session_host.diagnostics' | 'session.modal' | 'workspace.git'
>;

/**
 * Dispatch family. It selects the context the router builds for `run`:
 * low/med/high = the router family contexts, `handler` = the
 * DaemonCommandHandler (CDP / chat / stream / provider commands), `git` = the
 * git command services (dispatched through the handler's pre-checks).
 */
export type CommandFamily = 'low' | 'med' | 'high' | 'handler' | 'git';

export type CommandContextFor<F extends CommandFamily> =
    F extends 'low' ? LowFamilyContext
        : F extends 'med' ? MedFamilyContext
            : F extends 'high' ? HighFamilyContext
                : F extends 'handler' ? DaemonCommandHandler
                    : GitCommandServices | undefined;

export interface CommandSessionAttributes {
    /**
     * `required`: the command addresses ONE live session. When the caller named
     * a `targetSessionId` that does not resolve, the handler fails closed with
     * `Live session not found for targetSessionId: …` instead of acting on
     * whatever session is current. `optional`: the command may address a
     * session (only meaningful together with `aliasSessionId`).
     */
    scope: 'required' | 'optional';
    /**
     * Also fail with `No targetSessionId specified — cannot route command` when
     * the command carries no route at all (no session, no manager key, no
     * provider type). These are the commands that would otherwise spam CDP
     * retries against nothing.
     */
    requireRoute?: boolean;
    /** Accept `sessionId` as an alias for `targetSessionId` (all sources). */
    aliasSessionId?: boolean;
    /**
     * A missing live session is not fatal when the caller supplies a provider
     * type plus a session identity hint: the command can serve historical
     * transcript data for a stopped session.
     */
    allowInactiveHistory?: boolean;
}

export interface CommandSpec<F extends CommandFamily = CommandFamily> {
    name: string;
    family: F;
    run(ctx: CommandContextFor<F>, args: any): Promise<CommandRouterResult>;
    session?: CommandSessionAttributes;
    /**
     * Session-scoped command that must reach the daemon OWNING the target
     * session: when the session is a mesh worker hosted on a remote daemon, the
     * router forwards the command there instead of executing it locally.
     */
    forwardToOwner?: boolean;
    /**
     * Dashboard subscription topics this command invalidates. After
     * {@link CommandRegistry.build} this is the complete set: the declared
     * topics plus every matching {@link PrefixDefault}.
     */
    invalidates?: readonly CommandInvalidationTopic[];
    /** Refused while a mandatory daemon update is pending (cloud). */
    blockedDuringMandatoryUpdate?: boolean;
    /** A successful run pushes status to the dashboard immediately. */
    fastFlush?: boolean;
    /** Chat-affecting command: runs the post-chat hooks after it executes. */
    postChat?: boolean;
    /** Sources allowed to run this command. Default: all. */
    sources?: readonly CommandSource[];
    /**
     * Who may send this command over the daemon↔daemon mesh relay (source
     * `mesh`), evaluated by the router against the transport-stamped sender
     * (commands/mesh-sender.ts). REQUIRED for every command that accepts the
     * `mesh` source — a command accepting `mesh` without it is refused at run
     * time (`mesh_sender_policy_missing`) and fails
     * test/commands/mesh-sender-registry.test.ts.
     */
    meshSender?: MeshSenderClass;
}

/** Whether a spec can be run with source `mesh` (no `sources` list = all sources). */
export function specAcceptsMeshSource(spec: Pick<CommandSpec, 'sources'>): boolean {
    return !spec.sources || spec.sources.includes('mesh');
}

/** Attributes a family file declares next to a handler. */
export type CommandSpecAttributes = Omit<CommandSpec, 'name' | 'family' | 'run'>;

/** Name-prefix invalidation rule, applied to registered and unregistered names alike. */
export interface PrefixDefault {
    prefix: string;
    invalidates: readonly CommandInvalidationTopic[];
}

/** The only prefix rules left; everything else is declared on the spec. */
export const COMMAND_PREFIX_DEFAULTS: readonly PrefixDefault[] = [
    { prefix: 'workspace_', invalidates: ['daemon.metadata'] },
    { prefix: 'session_host_', invalidates: ['daemon.metadata', 'session_host.diagnostics'] },
    { prefix: 'git_', invalidates: ['workspace.git'] },
    // Mesh-graph / node-session topology changes the dashboard renders.
    { prefix: 'mesh_', invalidates: ['daemon.metadata'] },
];

type FamilyHandler<F extends CommandFamily> = (ctx: CommandContextFor<F>, args: any) => Promise<CommandRouterResult>;

/**
 * Turn a family file's `name → handler` table into specs, attaching the
 * attributes declared for some of its names. An attribute for a name the
 * table does not define is a programming error and throws at load.
 *
 * `defaults` are the file-wide attributes every spec of the table starts from
 * (a per-name attribute overrides them) — used for the file's mesh-sender
 * posture (`meshSender`), which every mesh-capable command must declare.
 */
export function defineCommandSpecs<F extends CommandFamily>(
    family: F,
    handlers: Record<string, FamilyHandler<F>>,
    attributes: Record<string, CommandSpecAttributes> = {},
    defaults: CommandSpecAttributes = {},
): CommandSpec<F>[] {
    for (const name of Object.keys(attributes)) {
        if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
            throw new Error(`command attributes declared for '${name}' but no ${family} handler defines it`);
        }
    }
    return Object.entries(handlers).map(([name, run]) => ({
        name,
        family,
        run,
        ...defaults,
        ...(attributes[name] ?? {}),
    }));
}

const NO_TOPICS: ReadonlySet<CommandInvalidationTopic> = new Set();

export class CommandRegistry {
    private constructor(
        private readonly byName: ReadonlyMap<string, CommandSpec>,
        private readonly prefixDefaults: readonly PrefixDefault[],
    ) {}

    /**
     * Build the registry. Throws on a duplicate command name — two handlers for
     * one name used to be resolved silently by lookup order.
     */
    static build(specs: readonly CommandSpec[], prefixDefaults: readonly PrefixDefault[]): CommandRegistry {
        const byName = new Map<string, CommandSpec>();
        for (const spec of specs) {
            const existing = byName.get(spec.name);
            if (existing) {
                throw new Error(`duplicate command '${spec.name}' (${existing.family} vs ${spec.family})`);
            }
            const invalidates = mergeTopics(spec.invalidates, prefixTopics(spec.name, prefixDefaults));
            const { invalidates: _declared, ...rest } = spec;
            byName.set(spec.name, invalidates.length > 0 ? { ...rest, invalidates } : rest);
        }
        return new CommandRegistry(byName, prefixDefaults);
    }

    get(name: string): CommandSpec | undefined {
        return this.byName.get(name);
    }

    list(): readonly CommandSpec[] {
        return [...this.byName.values()];
    }

    /**
     * Topics an executed command invalidates. A registered command answers from
     * its spec; an unregistered name still matches the prefix rules (a host may
     * run a `workspace_*` / `git_*` name the registry does not know).
     */
    invalidationsFor(name: string): ReadonlySet<CommandInvalidationTopic> {
        if (typeof name !== 'string' || !name) return NO_TOPICS;
        const topics = this.byName.get(name)?.invalidates ?? prefixTopics(name, this.prefixDefaults);
        return topics.length > 0 ? new Set(topics) : NO_TOPICS;
    }
}

function prefixTopics(name: string, prefixDefaults: readonly PrefixDefault[]): CommandInvalidationTopic[] {
    const topics: CommandInvalidationTopic[] = [];
    for (const rule of prefixDefaults) {
        if (name.startsWith(rule.prefix)) topics.push(...rule.invalidates);
    }
    return mergeTopics(topics, []);
}

function mergeTopics(
    a: readonly CommandInvalidationTopic[] | undefined,
    b: readonly CommandInvalidationTopic[],
): CommandInvalidationTopic[] {
    return [...new Set([...(a ?? []), ...b])];
}
