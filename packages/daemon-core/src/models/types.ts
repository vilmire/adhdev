/**
 * Model discovery types — "which models does this installed CLI actually
 * offer, on this machine, for this account".
 *
 * WHY THIS EXISTS AT ALL: the provider manifest's `modelOptions` is a
 * hand-written list that drifts in BOTH directions. Measured 2026-09-23 against
 * the shipped manifests: codex's manifest stopped at `gpt-5.6-sol` while the
 * installed binary offers `gpt-6-astra`, AND still advertised four models the
 * binary no longer lists (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5-codex`,
 * `gpt-5-codex-mini`) — picking one of those selects a model that does not
 * exist. grok's manifest was missing the CLI's own default (`grok-4.7`). So an
 * "additive refresh" would be half a fix: discovery REPLACES the list for a
 * provider it successfully read, rather than merging into it.
 *
 * ★ACCOUNT SCOPE (the reason this is a runtime overlay, not a manifest edit):
 * these lists are not a universal catalog. `grok models` prints "You are logged
 * in with grok.com", `cursor-agent models` says "for this account", and kimi's
 * list comes out of an OAuth-provisioned local config. What a CLI offers
 * depends on who is signed in and what they pay for, so the answer belongs to
 * THIS machine's cache — never to the signed, content-addressed manifest that
 * every machine on the channel shares. See `overlay.ts` for the merge and
 * `persist.ts` for where it lands on disk.
 *
 * Shape mirrors `quota/types.ts` deliberately: same status vocabulary, same
 * "a provider that cannot answer says so rather than faking a value" rule.
 */
'use strict';

/**
 * How a provider's model list is obtained. Declared in the manifest so adding a
 * provider is a manifest edit, not a code change — with ONE deliberate
 * exception (`kind: 'none'`) that is also declared rather than inferred.
 *
 *  - `command` — spawn the CLI's own listing subcommand (`codex debug models`,
 *                `grok models`, `cursor-agent models`, `agy models`,
 *                `opencode models`) and parse stdout.
 *  - `file`    — read a local config the CLI itself maintains. kimi has no
 *                listing subcommand; its models live in `~/.kimi-code/config.toml`
 *                as `[models."<slug>"]` table headers.
 *  - `none`    — ★this provider CANNOT be discovered, stated explicitly and
 *                with a reason. claude-cli ships no listing subcommand (checked:
 *                5 subcommands, `--list-models` rejected, no local catalog) and
 *                its `modelOptions` are stable ALIASES (`opus`, `sonnet`) that
 *                do not drift the way version slugs do. hermes-cli only selects
 *                models interactively.
 *
 * ★Why `none` is declared instead of simply omitting the block: a provider with
 * no declaration and a provider that is known-undiscoverable are different
 * facts, and the staleness badge must tell them apart. Silence would let the UI
 * render "up to date" for a list nothing ever checked — the same class of
 * comfortable lie as a phantom approval. See `modelListCannotVerifyTypes`.
 */
export type ModelDiscoveryKind = 'command' | 'file' | 'none';

/** Output shapes the parsers understand. These three cover all six discoverable providers. */
export type ModelDiscoveryFormat = 'json' | 'lines' | 'toml-table-keys';

/**
 * Parse instructions for a discovery source. Which fields apply depends on
 * `format`; the parser ignores the rest.
 */
export interface ModelDiscoveryParse {
    format: ModelDiscoveryFormat;

    // ─── format: 'json' ───
    /** Dot path to the array of model records (e.g. `models`). Absent → the root must be an array. */
    itemsPath?: string;
    /** Record field holding the model identifier passed to the CLI. */
    slugField?: string;
    /** Record field holding the human label, when the provider has one. */
    labelField?: string;
    /**
     * Keep only records whose fields all equal these values (e.g.
     * `{ visibility: 'list' }` drops codex's hidden/internal entries). A record
     * missing a filtered field fails the filter — fail closed, so an unexpected
     * shape yields fewer models rather than junk ones.
     */
    filter?: Record<string, string | number | boolean>;
    /**
     * Record field carrying a sort key (codex's `priority`). Lower sorts first.
     * Absent → source order is preserved, which is itself meaningful for every
     * `lines` provider (they all print best-first).
     */
    priorityField?: string;

    // ─── format: 'lines' ───
    /**
     * Regex applied per line, with named groups `slug` and optionally `label`.
     * Lines that do not match are skipped, which is how banner text
     * ("Fetching available models...", "You are logged in with grok.com") is
     * excluded without a separate skip list.
     */
    linePattern?: string;
    /** Regex flags for `linePattern`. ★Never assume `m` — the pattern runs per line. */
    lineFlags?: string;
    /**
     * A line matching this marks the model on it as the provider's default
     * (grok prints `* grok-4.7 (default)`). Default models sort first.
     */
    defaultMarker?: string;

    // ─── format: 'toml-table-keys' ───
    /**
     * Regex with a named `slug` group matched against TOML table headers, e.g.
     * `^\[models\."(?<slug>[^"]+)"\]` for kimi. Deliberately a header scan and
     * not a TOML parse: we need the ORDER and the keys, and a full parse would
     * add a dependency to read four lines.
     */
    tableHeaderPattern?: string;
}

/**
 * The manifest's `modelDiscovery` block.
 *
 * ★Discriminated on `kind` so `none` cannot silently carry a half-configured
 * command, and a `command` entry cannot omit its argv.
 */
export type ModelDiscoverySpec =
    | {
          kind: 'command';
          /**
           * Args appended to the provider's resolved binary. The binary itself
           * is NEVER specified here — it comes from provider detection, so
           * discovery can only ever run the CLI the user already installed and
           * this block can never introduce a new executable.
           */
          argv: string[];
          parse: ModelDiscoveryParse;
          /** How long a successful read stays authoritative. */
          ttlMs?: number;
          /** Spawn timeout. These commands may hit the network (see `agy`'s "Fetching…"). */
          timeoutMs?: number;
      }
    | {
          kind: 'file';
          /** Path to the CLI's own config, `~` expanded. Read-only, always. */
          path: string;
          parse: ModelDiscoveryParse;
          ttlMs?: number;
      }
    | {
          kind: 'none';
          /** Why this provider cannot be discovered. Surfaced to the user verbatim. */
          reason: string;
      };

/** Lifecycle of a discovery snapshot. Mirrors QuotaStatus minus the states that cannot occur here. */
export type ModelDiscoveryStatus = 'ok' | 'error' | 'unavailable' | 'not-supported';

/**
 * Why a discovery failed. The UI branches on this to decide between "sign in",
 * "we'll retry", and "this provider never supports it".
 */
export type ModelDiscoveryFailureKind =
    /** The provider's binary is not installed / not detected on this machine. */
    | 'cli-unavailable'
    /**
     * ★The command ran but the user is not signed in, or the machine is
     * offline. This is the case the investigation flagged as UNVERIFIED and it
     * is why `resolveModelOptions` falls back to the manifest: a signed-out
     * `grok models` or `agy models` must NEVER resolve to an empty picker.
     */
    | 'unauthenticated'
    | 'network'
    | 'timeout'
    /** Command succeeded but its output did not parse into any model. */
    | 'parse'
    | 'unknown';

/** One discovered model. `label` is present only where the provider supplies one. */
export interface DiscoveredModel {
    slug: string;
    label?: string;
}

/**
 * A provider's discovery result as cached and reported.
 *
 * `models` is empty for every non-ok status — a failed read never invents a
 * list, and callers fall back to the manifest rather than to nothing.
 */
export interface ModelDiscoverySnapshot {
    provider: string;
    status: ModelDiscoveryStatus;
    models: DiscoveredModel[];
    /** When this reading was captured (ms epoch). */
    updatedAt: number;
    /** When a refresh was last ATTEMPTED — moves even when the attempt failed. */
    fetchedAt: number;
    failureKind?: ModelDiscoveryFailureKind;
    error?: string;
    /** For `kind: 'none'`, the manifest's stated reason. */
    reason?: string;
}

/** Failure kinds worth retrying soon — the condition can resolve without user action. */
export const TRANSIENT_MODEL_DISCOVERY_FAILURE_KINDS: ReadonlySet<ModelDiscoveryFailureKind> = new Set([
    'network',
    'timeout',
]);
