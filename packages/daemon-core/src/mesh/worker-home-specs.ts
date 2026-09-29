// Per-provider worker-private HOME specs (which files/dirs a delegated worker's
// private home imports from the owner's, and how) — declarative data plus its
// types. Split out of worker-mcp-isolation.ts (re-exported there).

import * as path from 'path';
import { realpathSync } from 'fs';

// ─── Worker-private HOME ────────────────────────────────────────────────

/**
 * Files a home-rooted provider must still see inside its worker-private HOME
 * for the CLI to stay logged in.
 *
 * `mode` semantics:
 *  - `symlink` — the real file is linked, so a token REFRESHED by the worker
 *    (or by any sibling) is visible to everyone. Auth material must use this;
 *    a copy would freeze a refresh token and silently expire the worker.
 *  - `copy` — worker gets its own snapshot. For files the worker may rewrite
 *    and whose rewrite must not leak back into the user's real config.
 */
export interface WorkerHomeImport {
    /**
     * Path relative to the PRIVATE ROOT — i.e. the path as the CLI sees it under
     * the override, e.g. `.gemini/antigravity-cli/antigravity-oauth-token` for a
     * `HOME`-rooted spec, or plain `auth.json` for codex under `CODEX_HOME`.
     *
     * ★The real-home SOURCE is not always this same path. When the spec declares
     * `configRootPrefix`, the private root stands in for `~/<prefix>`, so the
     * source is `~/<prefix>/<relativePath>` while the target stays
     * `<root>/<relativePath>`. `prepareWorkerPrivateHome` applies that.
     *
     * ★Why this is spelled out (live regression, rc.16, fixed 2026-09-19).
     *
     * The four env-var specs were written with root-relative paths — correct for
     * the target — but `prepareWorkerPrivateHome` joined BOTH source and target
     * from the one string. So codex looked for `~/auth.json` and kimi for
     * `~/config.toml`; neither exists (they live under `~/.codex` and
     * `~/.kimi-code`). The entries are deliberately NOT `required` — see each
     * spec for the fail-OPEN argument, which remains right — so every source
     * missed the `existsSync` check and was SKIPPED SILENTLY. The private root
     * was created empty and the CLI launched with no credentials at all:
     *
     *   codex-cli → exit 1 after 3s, `unexpected_exit`
     *   kimi      → "Model 'kimi-code/k3' is not configured in config.toml"
     *
     * Measured on disk at the time: of 34 `codex-cli-*` private roots, 33 were
     * completely empty and ZERO contained `auth.json`. The `HOME`-rooted specs
     * (antigravity) were unaffected, which is why the class went unnoticed.
     *
     * ★A test asserting `existsSync(source)` or inspecting `skipped` cannot catch
     * this — a skip is indistinguishable from a legitimately absent optional
     * file. The regression test asserts the TARGET exists inside the root.
     */
    relativePath: string;
    mode: 'symlink' | 'copy';
    /**
     * When true, a missing source is an error rather than a skip.
     *
     * Also accepts a per-platform predicate (`(platform) => boolean`) for a
     * surface whose "the auth store is HOME-independent" status differs by
     * OS — see the antigravity `antigravity-oauth-token` entry below for the
     * measured case this exists for. A plain boolean applies to every
     * platform, matching prior behavior for every other entry in this file.
     */
    required?: boolean | ((platform: NodeJS.Platform) => boolean);
    /**
     * Assert the source is owner-only (0600/0700) before importing. Set on
     * credential material; leave off for shared data directories, which are
     * legitimately group/world-readable and would otherwise be refused.
     */
    requireOwnerOnly?: boolean;
}

/**
 * A surface whose path inside HOME is not knowable until launch time because it
 * is derived from the WORKSPACE.
 *
 * ★Why this exists at all (measured 2026-09-17, cursor-cli).
 *
 * `WorkerHomeImport.relativePath` is a static string, which works for every
 * antigravity surface because antigravity roots its transcripts at a fixed
 * `~/.gemini/antigravity-cli/conversations`. cursor does not: it files each
 * workspace under `~/.cursor/projects/<slug>/`, where `<slug>` is derived from
 * the workspace path. A static spec cannot name that directory.
 *
 * The daemon still reads transcripts from the REAL home — `expandPath()` in
 * `providers/spec/native-history-executor.ts` expands a literal `~` through
 * `os.homedir()` unconditionally, consulting `envOverrides` only for `${VAR}`
 * syntax. So a cursor worker writing transcripts into its private HOME would be
 * invisible to the daemon and every cursor worker would report zero assistant
 * messages — the same trap documented for antigravity below, arriving through a
 * path a static `relativePath` cannot express.
 *
 * ★`relativePath` here is deliberately the LEAF (`agent-transcripts`), never the
 * project directory itself. The project directory also holds `mcp-approvals.json`
 * and `.workspace-trusted`; linking the parent would route the worker's approval
 * writes straight back into the owner's real store — re-opening exactly the leak
 * the private HOME exists to close.
 */
export interface WorkerWorkspaceLink {
    /**
     * Directory under HOME that holds one entry per workspace,
     * e.g. `.cursor/projects`.
     */
    projectsDir: string;
    /**
     * Surface INSIDE the per-workspace directory to link through. Must be a
     * leaf, not the per-workspace directory itself — see the note above.
     */
    relativePath: string;
    mode: 'symlink';
}

export interface WorkerPrivateHomeSpec {
    /** Provider type this spec applies to. */
    providerType: string;
    /**
     * ★Environment variable the CLI reads its CONFIG ROOT from, when that root
     * is not `$HOME`.
     *
     * Absent (antigravity, cursor, grok) means the provider roots its config in
     * `~`, so the launch seam redirects `HOME` itself and the private directory
     * IS the worker's home.
     *
     * Present (codex, kimi, opencode, hermes) means the CLI exposes a dedicated
     * config-root variable, and redirecting that variable is strictly cheaper
     * and safer than redirecting `HOME`:
     *
     *  - `HOME` is read by everything the worker spawns — git, ssh, the shell,
     *    every tool the agent invokes. Repointing it to isolate ONE CLI's MCP
     *    table changes the behavior of the whole process tree, and each surface
     *    that breaks has to be linked back one file at a time. That is the debt
     *    the three `HOME`-rooted specs above carry, and it is only paid because
     *    those CLIs offer no alternative.
     *  - A dedicated variable moves exactly the config root and nothing else,
     *    so surfaces the CLI keeps OUTSIDE that root (opencode's `auth.json`
     *    under `XDG_DATA_HOME`) stay reachable with no import at all.
     *
     * ★Measured, not assumed — each value below was verified by running the
     * installed CLI with the variable pointed at an empty directory and
     * confirming the owner's MCP servers disappeared. See each spec's comment.
     *
     * When set, `~`-rooted `mcpConfig.path` values still resolve against the
     * private directory (that is what makes the provider isolable), but the
     * launch seam must NOT export `HOME` — see `cli-delegated-launch.ts`.
     */
    homeEnvVar?: string;
    /**
     * ★The HOME-relative directory that the private root STANDS IN FOR.
     *
     * Only meaningful alongside `homeEnvVar`. When the env var names a config
     * directory rather than a home, the private root IS that directory — so the
     * real-home counterpart of anything inside it lives one segment deeper, at
     * `~/<prefix>/…`, while inside the root it sits at the top level.
     *
     * ★This asymmetry governs TWO axes, and both must honour it:
     *
     *  1. **Config write** (`resolveWorkerMcpConfigPath`). The declared
     *     `mcpConfig.path` is shared with the COORDINATOR writer, which resolves
     *     it against the real home and must keep doing so — so it cannot be
     *     rewritten to suit the worker. The prefix is collapsed off the declared
     *     `~/<prefix>/…` path so the worker writes where the CLI actually reads.
     *
     *  2. **Imports** (`prepareWorkerPrivateHome`). `WorkerHomeImport.relativePath`
     *     is declared ROOT-relative — the path as the CLI sees it under the
     *     override. The prefix is therefore PREPENDED to reach the real-home
     *     source. See `WorkerHomeImport.relativePath` for the measurements, and
     *     for the live regression that established this field must span both.
     *
     * Measured 2026-09-19 (all three under an override pointed at a scratch dir):
     *
     *   HERMES_HOME=<dir> hermes config path     → <dir>/config.yaml
     *   HERMES_HOME=<dir> hermes config env-path → <dir>/.env
     *   CODEX_HOME=<dir with auth.json AT ROOT>  codex login status
     *     → "Logged in using ChatGPT";  nested <dir>/.codex/auth.json → "Not logged in"
     *   KIMI_CODE_HOME=<dir with config.toml AT ROOT> kimi --prompt "say OK"
     *     → ran to completion;  nested <dir>/.kimi-code/… → "No model configured",
     *       identical to an EMPTY root (so the nested layout imports nothing)
     *
     * Absent means the private root is a HOME (antigravity, cursor, grok — they
     * redirect `HOME` itself, so real and private paths coincide) or a root the
     * declared paths are already relative to (opencode: `XDG_CONFIG_HOME`, whose
     * `opencode/` subdirectory is named explicitly in `ensureDirs`).
     */
    configRootPrefix?: string;
    imports: WorkerHomeImport[];
    /**
     * Directories that must exist (empty) in the private HOME. These are the
     * surfaces being ISOLATED — creating them empty is what stops the CLI from
     * falling back to the real HOME's copy.
     */
    ensureDirs?: string[];
    /**
     * Surfaces keyed by a workspace-derived directory name, resolved at prepare
     * time from `opts.workspace`. See `WorkerWorkspaceLink`.
     */
    workspaceLinks?: WorkerWorkspaceLink[];
}

/**
 * Derive cursor's per-workspace project directory name from a workspace path.
 *
 * ★The rule is: collapse every run of non-alphanumeric characters to ONE `-`,
 * then strip leading/trailing dashes. Not a per-separator substitution.
 *
 * ★This was measured live 2026-09-17 by running `cursor-agent` under an
 * isolated HOME and reading back the directory it created — and the first
 * measurement got it WRONG in a way worth recording, because it is the exact
 * silent-failure this whole mechanism is exposed to.
 *
 * The first probe used a workspace whose path contained no dashes, so
 * "replace each separator with a dash" and "collapse runs of non-alphanumerics"
 * produced identical output and the probe could not tell them apart. Against a
 * real ADHDev worktree path — which contains `/-Users-vilmire--adhdev-…` — the
 * two rules diverge: cursor writes `…-501-Users-vilmire-adhdev-…` where the
 * naive rule yields `…-501--Users-vilmire--adhdev-…`. A second probe with a
 * deliberately dash-laden path (`/-lead--double/x` → `…-lead-double-x`) settled
 * it, and the collapse rule then reproduced all three live observations exactly,
 * including a 186-character slug.
 *
 * ★The failure mode is silent: a wrong slug is not an error, it is a symlink to
 * a directory the CLI never writes. Transcripts would land in the worker's
 * private HOME, the daemon would glob the real home and find nothing, and every
 * cursor worker would report zero assistant messages with no diagnostic. Do not
 * "simplify" this back to a separator substitution.
 *
 * ★No length cap: a 186-char slug was produced intact. The `…--<7hex>`-suffixed
 * directories in the owner's real store are a SEPARATE cursor disambiguation
 * case (five distinct worktree paths sharing one 51-char prefix), deliberately
 * not modelled here — it has not been measured, and guessing at it would
 * reintroduce exactly the silent mis-key described above.
 *
 * Resolves symlinks first because cursor keys off the path it actually opens.
 */
export function deriveCursorWorkspaceSlug(workspace: string, realpath?: (p: string) => string): string {
    const raw = path.resolve(String(workspace || ''));
    let resolved = raw;
    try {
        resolved = (realpath || realpathSync)(raw);
    } catch {
        // A workspace that does not exist yet keeps its literal path — the
        // launch will create it, and the unresolved form is what cursor sees.
    }
    // Collapse every run of non-alphanumerics (separators, dashes, dots, win32
    // drive colons) to a single dash, then trim the ends.
    return resolved.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * ★antigravity-cli is the only provider carrying a private HOME in Phase A.
 *
 * Owner decision (2026-08-28, §12-1a): worker-private temp HOME with the auth
 * surface imported. Option (b) — a provider-level config-path override — was
 * measured as unavailable: antigravity exposes no such flag, so there is
 * nothing to point elsewhere.
 *
 * ─── ★The transcript trap (measured, and it decides the shape here) ───────
 *
 * A NAIVE private HOME — an empty tempdir with only the two auth files linked
 * in — silently destroys transcript collection for every antigravity worker.
 *
 * The reason is asymmetric HOME resolution. The worker writes its transcripts
 * under ITS `$HOME/.gemini/antigravity-cli/`, but the DAEMON reads them from
 * `os.homedir()` hard-coded in `providers/native-history/antigravity-cli-
 * transcript.ts` (`antigravityRoot()`, feeding ~8 private call sites) and in
 * `native-history/dispatcher.ts` (`resolveAntigravityPath`). Neither consults
 * the manifest's `watchPath`: the loader discards it (`provider-loader.ts`
 * sets `watchPath: undefined`) because antigravity resolves to the BUILT-IN
 * `reader: "antigravity-cli"` from its spec, not the declarative `source`
 * executor. So the `${VAR}`/`envOverrides` expansion that makes hermes's
 * HERMES_HOME precedent work is never reached on this path.
 *
 * Net effect of a naive tempdir HOME: worker writes to /tmp/…/.gemini/…,
 * daemon reads ~/.gemini/…, and every session reports zero assistant
 * messages. The completion engine would then fall back to screen-scraped
 * evidence — quietly degrading exactly the signal Phase B exists to improve.
 *
 * ─── The shape that avoids it ────────────────────────────────────────────
 *
 * Isolate ONLY the surface that must differ, and link the rest THROUGH to the
 * real home so the daemon's reader keeps working with no code change:
 *
 *  - `.gemini/config/` — created EMPTY and private. This is the coordinator's
 *    `mcp_config.json` surface, i.e. the entire point of the exercise. The
 *    worker's own config is written here, so the coordinator's 60-tool entry
 *    is absent rather than present-and-disabled.
 *  - `.gemini/antigravity-cli/{brain,conversations}` and `history.jsonl` —
 *    SYMLINKED to the real home. The worker writes transcripts into the real
 *    directories, so the daemon's `os.homedir()` reads find them exactly where
 *    they have always been.
 *  - `antigravity-oauth-token` — SYMLINKED, never copied. The CLI refreshes
 *    this blob in place; a copy would strand the worker on a token that
 *    expires mid-task while the real one rotates.
 *  - `settings.json` — COPIED. Carries non-secret onboarding/auth selection
 *    state, then receives the worker trust projection without a write-through
 *    path to the user's real settings.
 *  - `cache/onboarding.json` — COPIED. Suppresses the first-run colour-scheme
 *    and Terms-of-Service TUI, which nobody can answer inside a worker PTY.
 *
 * Launch planning now resolves an absolute trust plan after this copy exists,
 * records/reuses the daemon-owned worker-auto grant, and materializes the
 * provider-native projection into this per-worker file before PTY spawn.
 * Therefore no shared writable trust store or settings symlink is needed.
 *
 * `jetski_state.pbtxt` is deliberately NOT imported. It holds an
 * `installation_uuid` plus a `post_onboarding` block, so it reads like a third
 * onboarding candidate — but the observed hang is gated on
 * `cache/onboarding.json` alone, and the file is an install-identity record:
 * copying it would clone one installation's UUID across every worker HOME,
 * corrupting whatever telemetry or migration bookkeeping keys off it, and
 * symlinking it would expose that identity file to worker writes. Import it
 * only if a first-run screen is ever measured that onboarding.json does not
 * already suppress.
 *
 * ★Choosing symlinks over threading a HOME override through the reader is
 * deliberate. The override route means forwarding `envOverrides` through
 * `createNativeHistoryDispatcher` (which today does not forward it at all) and
 * parameterizing ~8 private call sites — a change to the shared transcript
 * reader, made for one provider, in the phase whose whole promise is
 * "gate off ⇒ byte-identical". Symlinks buy the same isolation with zero
 * change to any read path. If a second home-rooted provider ever needs this,
 * revisit — one provider does not justify re-plumbing the reader.
 */
export const WORKER_PRIVATE_HOME_SPECS: readonly WorkerPrivateHomeSpec[] = [
    {
        providerType: 'antigravity-cli',
        imports: [
            // Security.framework resolves the default keychain through HOME.
            // Keep the worker-private HOME while linking macOS's keychain
            // directory back to the real home. This stays optional and
            // platform-agnostic: hosts without this path use the generic
            // missing-import skip contract below.
            { relativePath: path.join('Library', 'Keychains'), mode: 'symlink' },
            // ★`required` only on linux (fixed 2026-09-25, live rc.44 defect).
            //
            // This file is a DEAD FALLBACK on darwin/win32 — see
            // `quota/fetchers/antigravity.ts` header ("CREDENTIAL SOURCE") for the
            // measured evidence: on those two platforms `agy` authenticates through
            // the OS keyring (macOS Keychain via `/usr/bin/security`, win32 wincred
            // via CredRead), logged `ChainedAuth: authenticated via keyring
            // (effective: keyring)` 15/15 times on the survey machine, and the file
            // never gets written or refreshed there — its mtime "stayed frozen weeks
            // in the past while the keychain item was rewritten on every login".
            // Only headless linux (no Secret Service) writes this path at all.
            //
            // Both keyring backends are looked up by a fixed service/account pair
            // (`security find-generic-password -s gemini -a antigravity`;
            // `LegacyGeneric:target=gemini:antigravity`) — neither is keyed by
            // `$HOME`, so a worker-private HOME does not affect what the CLI can
            // read from either store. The `Library/Keychains` symlink above already
            // carries the darwin keyring through; win32 wincred is a machine-wide
            // store with no per-HOME scoping to carry through at all.
            //
            // Making this entry unconditionally `required: true` therefore aborted
            // EVERY darwin/win32 private-HOME build over a file those platforms were
            // never going to use anyway — the exact fail-CLOSED-in-the-wrong-place
            // bug `worker_private_home_missing_required_import` exists to name. The
            // owner had `agy` logged in the whole time; the file just was not there
            // to symlink. On linux it stays required: it is the ONLY credential
            // source on that platform, so a missing file there is a genuine
            // "not signed in", not a dead fallback.
            {
                relativePath: path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
                mode: 'symlink',
                required: (platform) => platform === 'linux',
                requireOwnerOnly: true,
            },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'settings.json'), mode: 'copy', requireOwnerOnly: true },
            // First-run onboarding completion — COPIED, never symlinked. Without
            // it the CLI opens its colour-scheme picker and then the Terms of
            // Service screen inside the worker PTY, where nobody is there to
            // answer: the session sits in `starting` making zero model calls
            // until it is reaped. Private HOMEs are keyed per TASK, so every
            // task would re-onboard without this.
            // Copy rather than symlink because the worker has no reason to
            // rewrite it, and a symlink would let a worker's write land in the
            // real user config. Not `required`: a host that has never run agy
            // (or any non-mac host laid out differently) must still launch, and
            // the generic missing-import skip contract covers it.
            { relativePath: path.join('.gemini', 'antigravity-cli', 'cache', 'onboarding.json'), mode: 'copy' },
            // Transcript surfaces — linked THROUGH so the daemon's
            // os.homedir()-rooted reader still finds what the worker writes.
            // Not `required`: a fresh machine may not have them yet, and the
            // CLI creates them on first use inside the linked-through parent.
            { relativePath: path.join('.gemini', 'antigravity-cli', 'brain'), mode: 'symlink' },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'conversations'), mode: 'symlink' },
            { relativePath: path.join('.gemini', 'antigravity-cli', 'history.jsonl'), mode: 'symlink' },
        ],
        ensureDirs: [path.join('.gemini', 'config')],
    },
    /**
     * ★cursor-cli (owner-approved 2026-09-17). Two measured gates, not one.
     *
     * A cursor worker was observed holding ZERO of its six worker tools while
     * carrying FIFTY of the owner's personal global MCP servers. The worker MCP
     * config the daemon writes is correct — cursor's READ side drops it:
     *
     *  ① Approval gate. `~/.cursor/projects/<slug>/mcp-approvals.json` is an
     *     allowlist keyed `<serverName>-<contentHash>`. The worker entry hashes
     *     differently from the coordinator's (different args and env), so it is
     *     unapproved — and an unapproved server is dropped SILENTLY, with no
     *     prompt. Worktree slugs have no approvals file at all, and the
     *     empty/absent state was measured to be the same silent drop.
     *  ② Global merge. cursor unions `~/.cursor/mcp.json` with the workspace
     *     config. The owner's personal servers arrive through that union, which
     *     is why the workspace-scoped config alone never isolated anything.
     *     (opencode looked isolated only because the owner has no global block.)
     *
     * The private HOME answers ②: `.cursor` is created EMPTY, so there is no
     * global `mcp.json` to union in. `meshCoordinator.launchArgs`'
     * `--approve-mcps` answers ①, and the two are a PAIR — `--approve-mcps`
     * without the empty HOME would approve the owner's global servers wholesale,
     * which is strictly worse than the status quo. Do not ship either alone.
     *
     * `cli-config.json` is deliberately NOT imported. It holds no token (auth
     * rides the keychain, and a `Library/Keychains` symlink alone was measured
     * sufficient: `✓ Logged in as …`), cursor REWRITES it on every invocation so
     * a symlink would let a worker mutate the owner's file, and it is 0644 so
     * `requireOwnerOnly` would throw on it. cursor recreates it unprompted.
     *
     * ★Workspace trust resets inside a private HOME, and the thing that keeps
     * cursor workers from wedging on the trust prompt is `--trust` in the
     * provider's `spawn.args`. An arg refactor that drops it stalls EVERY cursor
     * worker — the prompt is unanswerable inside a worker PTY.
     */
    {
        providerType: 'cursor-cli',
        imports: [
            // Auth. Measured sufficient on its own for `✓ Logged in as …`.
            // No requireOwnerOnly: this is a shared macOS data directory, not a
            // single credential file, and it is legitimately group-readable.
            { relativePath: path.join('Library', 'Keychains'), mode: 'symlink' },
        ],
        // The ISOLATED surface: empty means the owner's global `~/.cursor/mcp.json`
        // is not reachable and therefore cannot be merged in.
        ensureDirs: ['.cursor'],
        workspaceLinks: [
            // Transcripts must stay readable by the daemon, which globs the REAL
            // `~/.cursor/projects/*/agent-transcripts/*`. Leaf only — the parent
            // project directory holds `mcp-approvals.json` and
            // `.workspace-trusted`, and linking it would write the worker's
            // approvals into the owner's store.
            { projectsDir: path.join('.cursor', 'projects'), relativePath: 'agent-transcripts', mode: 'symlink' },
        ],
    },
    /**
     * ★grok-cli (measured live 2026-09-18, grok 1.0.34).
     *
     * A grok worker was observed holding SIXTY-ONE tools where six were
     * expected: the owner's personal `blender` (31), `godot` (13) and `tasks`
     * (11) servers were all present, and the worker's system prompt carried the
     * owner's cursor `user_rule` verbatim.
     *
     * ─── ★The measured mechanism, and why the obvious guess was wrong ────────
     *
     * The natural hypothesis was "grok shares `.mcp.json` with claude, so
     * claude's isolation does not cover grok". That is NOT what happens, and
     * acting on it would have fixed nothing.
     *
     * `grok inspect` labels every leaked server `.mcp.json [cursor]`, and the
     * bracketed tag is grok's COMPAT-SOURCE label, not a file path. grok ships a
     * harness-compatibility layer (`xai_grok_cursor::register()` in the binary;
     * `grok inspect` renders it as a "Harness Compatibility" block with
     * per-component `skills/rules/agents/mcps/hooks/sessions` toggles, all
     * defaulting to ON) that imports cursor's, claude's and codex's
     * configuration alongside its own.
     *
     * The leak is therefore HOME-scoped, and it was isolated to a single file by
     * probe: an otherwise-empty HOME containing ONLY `~/.cursor/mcp.json` — with
     * no `.mcp.json` anywhere and an empty workspace — still produced the server.
     * The owner's `~/.cursor/mcp.json` holds exactly `godot`, `blender`,
     * `context7`; `grok mcp list` (grok's own native store) is EMPTY. The same
     * compat layer imports cursor `rules`, which is where the `user_rule` in the
     * worker prompt came from.
     *
     * ∴ the leak arrives through `$HOME`, and a worker-private HOME closes it —
     * the identical shape cursor-cli already uses, for the identical reason.
     *
     * ─── Why the env toggles are NOT the fix ────────────────────────────────
     *
     * The binary exposes `GROK_CURSOR_MCPS_ENABLED` / `GROK_CLAUDE_MCPS_ENABLED`
     * (and per-component siblings), and setting them to `0` was measured to work
     * — too well. grok classifies the WORKSPACE `.mcp.json` under the same
     * compat source, so the toggle marks `adhdev-mesh` `[disabled]` along with
     * the owner's servers and the worker boots with zero tools. It is the
     * `--approve-mcps`-without-a-private-HOME failure in mirror image: an
     * isolation knob that also erases the surface being granted. Do not add
     * these to `env.set`.
     *
     * ─── ★The transcript trap (same class as antigravity's, and it applies) ──
     *
     * grok's manifest declares `nativeHistory.watchPath` as
     * `~/.grok/sessions/**` + chat_history.jsonl`, and `expandPath()` in
     * `providers/spec/native-history-executor.ts` expands a literal `~` through
     * `os.homedir()` UNCONDITIONALLY — `envOverrides` is consulted only for
     * `${VAR}` syntax. So a naive private HOME would have the worker writing
     * sessions under `/tmp/…/.grok/sessions` while the daemon globs
     * `~/.grok/sessions`, and every grok worker would report zero assistant
     * messages with no diagnostic.
     *
     * `.grok/sessions` is therefore SYMLINKED through to the real home, and this
     * was verified end-to-end rather than reasoned about: a headless run under a
     * prepared private HOME wrote its transcript directory into the REAL
     * `~/.grok/sessions/` (URL-encoded per cwd, as grok does).
     *
     * ─── What is isolated vs. linked ────────────────────────────────────────
     *
     *  - `.cursor` / `.claude` — created EMPTY. These are the ISOLATED surfaces:
     *    empty means the compat layer finds no owner config to import, which is
     *    the entire point. (`.grok` gets created implicitly by the imports.)
     *  - `auth.json` — SYMLINKED, never copied. grok refreshes this blob in
     *    place; a copy would strand the worker on a credential that expires
     *    mid-task while the real one rotates. Measured sufficient on its own: a
     *    headless run under the private HOME answered normally.
     *  - `.grok/sessions` — SYMLINKED. The transcript trap above.
     *  - `config.toml` — COPIED. Carries the owner's model default and
     *    `permission_mode`, which a worker should inherit, but grok REWRITES it
     *    (`grok mcp add` writes here), so a symlink would let a worker mutate
     *    the owner's file. It is 0644, so `requireOwnerOnly` must NOT be set.
     *  - `version.json` / `bin` — SYMLINKED so the worker resolves the same
     *    installed build and does not re-report its channel as `[unknown]`.
     *
     * `trusted_folders.toml` is deliberately NOT imported, and the resulting
     * `Project trusted: no` is ACCEPTED rather than worked around. In grok,
     * folder trust gates HOOK and PLUGIN execution — not the session — and every
     * probe ran to completion untrusted with no prompt. A worker that executes
     * none of the owner's project hooks is the isolation goal, not a regression.
     * Importing it would hand the worker the owner's hook-execution grants; a
     * symlink would additionally let a worker write new grants into the owner's
     * store, which is the worker-trust leak `resolveWorkerTrustHome()` exists to
     * prevent.
     *
     * ★No `delegatedWorkerIsolation.args` rule is declared for grok, and that is
     * correct, not an omission. cursor needs `--approve-mcps` because cursor
     * silently drops unapproved servers; grok has no approval gate — the private
     * HOME alone was measured to yield exactly one server (`adhdev-mesh`, source
     * `config`) with the owner's servers absent. The manifest's existing
     * `mcpConfig.path: ".mcp.json"` already lands the worker config where grok
     * reads it, so no path change is needed either.
     */
    {
        providerType: 'grok-cli',
        imports: [
            // Auth. Symlinked so an in-place refresh stays shared — see above.
            { relativePath: path.join('.grok', 'auth.json'), mode: 'symlink', required: true, requireOwnerOnly: true },
            // Transcripts — linked THROUGH so the daemon's os.homedir()-rooted
            // `watchPath` still finds what the worker writes. Not `required`: a
            // fresh machine may not have the directory yet, and grok creates it
            // on first use inside the linked-through parent.
            { relativePath: path.join('.grok', 'sessions'), mode: 'symlink' },
            // Non-secret preferences (model default, permission_mode). COPIED —
            // grok rewrites this file, and it is 0644 so it must not assert
            // owner-only.
            { relativePath: path.join('.grok', 'config.toml'), mode: 'copy' },
            // Installed-build identity, so the worker resolves the same version
            // and channel rather than reporting `[unknown]`.
            { relativePath: path.join('.grok', 'version.json'), mode: 'symlink' },
            { relativePath: path.join('.grok', 'bin'), mode: 'symlink' },
        ],
        // The ISOLATED surfaces: empty means grok's harness-compatibility layer
        // has no owner cursor/claude config to import — neither MCP servers nor
        // the `user_rule` that was observed in the worker prompt.
        ensureDirs: ['.cursor', '.claude'],
    },
    /**
     * ★codex-cli (measured live 2026-09-19, codex-cli 0.154.0).
     *
     * ─── The observation ────────────────────────────────────────────────────
     *
     * A codex worker was found RUNNING the owner's `node_repl` MCP server as a
     * child process. Not inferred from config — the child process was observed.
     *
     * ─── Why the existing rule did not stop it ──────────────────────────────
     *
     * codex's `delegatedWorkerIsolation.args` declares ONE `config_override`:
     * `-c mcp_servers.adhdev-mesh.enabled=false`. That disables the coordinator
     * entry by NAME, which is the only entry it knows to name. Every OTHER
     * server in `~/.codex/config.toml` is untouched — on this machine that is
     * `node_repl` and `computer-use`.
     *
     * This is the structural flaw in name-based disabling: it enumerates what to
     * remove, so it can only ever remove what was enumerated when it was written.
     * A server the owner adds tomorrow is inherited by every worker, silently.
     * An allow-list (isolate the root, then add back exactly one server) has the
     * opposite failure mode, which is the correct one here.
     *
     * ─── ★The fix, and why it is NOT a private HOME ─────────────────────────
     *
     * codex reads its config root from `$CODEX_HOME` (the binary's own `--help`
     * documents it under `--profile`: "Layer $CODEX_HOME/<name>.config.toml on
     * top of the base user config"). Measured on the installed 0.154.0:
     *
     *   CODEX_HOME=<empty dir> codex mcp list
     *     → "No MCP servers configured yet."      (owner's three are gone)
     *   CODEX_HOME=<dir with auth.json linked> codex login status
     *     → "Logged in using ChatGPT"             (auth survives)
     *
     * So one variable isolates the entire MCP table, and ONE symlink keeps the
     * worker authenticated. `HOME` is left alone, so git/ssh/shell inside the
     * worker behave exactly as before — see `homeEnvVar` above for why that
     * matters.
     *
     * ★`auth.json` is SYMLINKED, never copied. codex refreshes the ChatGPT token
     * in place; a copy would strand a long worker on a credential that expires
     * mid-task while the real one rotates. It is 0600, so `requireOwnerOnly`
     * holds and a loosened source is refused rather than laundered.
     *
     * ★`config.toml` is deliberately NOT imported, and that is the whole point:
     * it is the file the MCP table lives in. Importing it in any mode would
     * re-admit `node_repl`. The cost is that the worker loses the owner's
     * non-MCP preferences (model, sandbox policy) and falls back to codex's
     * built-in defaults — accepted, because the alternative is a filtered copy
     * that re-derives the enumeration failure described above.
     *
     * The worker MCP server arrives via `workerMcpDelivery`
     * (`config_override`), which injects it on argv and therefore does not
     * depend on any file in the config root. That part is unaffected by the
     * private root and remains correct.
     *
     * ★The `adhdev-mesh.enabled=false` rule, however, is NOT "redundant but
     * harmless" alongside this private root — an earlier revision of this
     * comment said so, and that was wrong. Measured 2026-09-19: because
     * `config.toml` is not imported, the entry does not exist in the private
     * root, so the override CREATES one carrying only `enabled=false`. codex
     * requires a transport (`command`/`url`) on every `mcp_servers` entry and
     * rejects the entire config —
     *
     *   Error loading config.toml: invalid transport
     *   in `mcp_servers.adhdev-mesh`
     *
     * — so the CLI exits before the session starts. The rule is therefore
     * declared `withholdWithPrivateHome: true` (provider manifest 1.1.23) and
     * applies only when there is no private root, which is exactly the
     * `ADHDEV_WORKER_MCP`-off case it was kept for. See the launch-seam
     * comment in `commands/cli-delegated-launch.ts`.
     *
     * ─── ★The transcript trap (measured live 2026-09-27 — it applies here too) ─
     *
     * This spec originally imported `auth.json` and nothing else, and that single
     * omission silently destroyed transcript collection for every codex worker.
     * It is the identical class documented at length for antigravity and grok
     * above, arriving through `CODEX_HOME` rather than `HOME`.
     *
     * The daemon's codex reader is `os.homedir()`-rooted and does not consult
     * `envOverrides`: `codexSessionsRoot()` in
     * `providers/native-history/codex-cli-transcript.ts` returns
     * `os.homedir()/.codex/sessions` (feeding both `readSession` and the
     * `listSessions` fallback), and `native-history/dispatcher.ts`'s
     * `resolveCodexPath` globs the same root. So with a private root and no link,
     * the worker writes rollout JSONL under
     * `$TMPDIR/adhdev-worker-home/codex-cli-<hash>/sessions/<Y>/<M>/<D>/` while
     * the daemon reads `~/.codex/sessions` — and every codex worker reports zero
     * assistant messages, with no diagnostic anywhere.
     *
     * Measured on disk the day it was found: a live worker's private root held a
     * 175-line rollout with 10 assistant entries, while `~/.codex/sessions` had
     * no directory newer than eight days. The coordinator still received the
     * worker's `report_completion` (that rides the mesh ledger and mailbox, not
     * the transcript), so the failure presented as "summary arrives, transcript
     * is empty" rather than as a broken worker.
     *
     * `sessions` is therefore SYMLINKED through to the real home, the same shape
     * grok (`.grok/sessions`), kimi (`sessions`) and hermes (`sessions`) already
     * use. Rewiring the reader instead was rejected for the reason given at the
     * head of the antigravity spec — symlinks buy the same isolation with zero
     * change to any read path.
     *
     * ★`history.jsonl` is deliberately NOT imported. It is the TUI's input
     * history (what the user typed at the prompt), not a transcript: the daemon
     * never reads it, so it carries no part of this defect, and leaving it
     * private keeps a worker's typed input out of the owner's recall buffer.
     */
    {
        providerType: 'codex-cli',
        homeEnvVar: 'CODEX_HOME',
        // `CODEX_HOME` names the `.codex` directory ITSELF, so `auth.json` sits
        // at the ROOT of the private dir while its real counterpart is
        // `~/.codex/auth.json`. Measured 2026-09-19: an `auth.json` linked at the
        // root reports "Logged in using ChatGPT"; the same link nested at
        // `<root>/.codex/auth.json` reports "Not logged in", exactly like an
        // empty root. Without this the import source resolved to `~/auth.json`,
        // which does not exist — see `WorkerHomeImport.relativePath`.
        configRootPrefix: '.codex',
        imports: [
            // ★NOT `required`. A failed required import aborts the private root
            // and falls back to the owner's config — a fail-OPEN for a spec
            // whose entire purpose is isolation, and the exact leak measured
            // here. A host authenticating codex by API key has no `auth.json`
            // and must still get an isolated worker.
            { relativePath: 'auth.json', mode: 'symlink', requireOwnerOnly: true },
            // Transcripts — linked THROUGH so the daemon's os.homedir()-rooted
            // reader still finds what the worker writes. See the transcript-trap
            // section above. Not `required`: a fresh machine has no sessions
            // directory yet, and codex creates the dated subtree on first use
            // inside the linked-through parent. A `required` entry here would
            // abort the private root and fall back to the owner's config — the
            // fail-OPEN this spec exists to prevent.
            { relativePath: 'sessions', mode: 'symlink' },
        ],
    },
    /**
     * ★kimi (measured live 2026-09-19, kimi 2.0.0).
     *
     * ─── The gap ────────────────────────────────────────────────────────────
     *
     * kimi merges THREE MCP sources: `$KIMI_CODE_HOME/mcp.json` (global), the
     * repo-root `.mcp.json`, and `<cwd>/.kimi-code/mcp.json`. The daemon writes
     * the worker config to the third, so the first two are inherited.
     *
     * On this machine `~/.kimi-code/mcp.json` does not currently exist, so the
     * gap is DORMANT, not harmless: the day the owner adds a global server every
     * kimi worker inherits it, with no signal. Closing it now costs one env var.
     *
     * ─── ★The fix, and the measurement that makes it cheap ──────────────────
     *
     * `$KIMI_CODE_HOME` relocates kimi's entire home. Pointed at an empty dir,
     * kimi lost auth ("No model configured") — proving `config.toml` and
     * `credentials/` are read from there, i.e. the redirect is real.
     *
     * ★The decisive measurement: `~/.kimi-code/config.toml` contains ZERO `mcp`
     * declarations (verified by grep — the MCP table lives only in the separate
     * `mcp.json`). So `config.toml` can be symlinked through WHOLE, carrying the
     * owner's model/provider/auth settings, without carrying a single MCP entry.
     * The isolated surface is simply the absence of `mcp.json` in the private
     * root. Verified end-to-end: a private `KIMI_CODE_HOME` with the surfaces
     * below linked ran a real prompt to completion ("OK") — auth intact.
     *
     * `config.toml` is SYMLINKED rather than copied because it carries OAuth
     * storage keys that rotate; the same in-place-refresh argument as every
     * other credential here. It is 0600, so `requireOwnerOnly` holds.
     *
     * ★Sessions/logs are linked through so the worker's transcripts stay where
     * the daemon reads them — the same trap documented at length for antigravity
     * and grok. `session_index.jsonl` is the index the CLI appends to.
     */
    {
        providerType: 'kimi',
        homeEnvVar: 'KIMI_CODE_HOME',
        // `KIMI_CODE_HOME` names the `.kimi-code` directory ITSELF — the surfaces
        // below sit at the ROOT of the private dir, while their real
        // counterparts are `~/.kimi-code/…`. Measured 2026-09-19: the root
        // layout ran `kimi --prompt "say OK"` to completion; the same links
        // nested at `<root>/.kimi-code/…` failed with "No model configured",
        // byte-identical to an EMPTY root — i.e. the nested layout imports
        // nothing. That empty-root failure is the live rc.16 symptom.
        configRootPrefix: '.kimi-code',
        imports: [
            // Auth + model config. Carries no MCP entries (measured), so linking
            // it whole does not re-admit anything this spec exists to exclude.
            //
            // ★NOT `required`, deliberately. A failed required import aborts the
            // whole private root and falls back to "worker shares the owner's
            // config" — for an ISOLATION spec that is a fail-OPEN, and it would
            // trigger on any host that has not yet run kimi interactively. An
            // unauthenticated worker fails loudly and locally; a silently
            // un-isolated one does not.
            { relativePath: 'config.toml', mode: 'symlink', requireOwnerOnly: true },
            { relativePath: 'credentials', mode: 'symlink', requireOwnerOnly: true },
            // 0755 on disk — must NOT assert owner-only.
            { relativePath: 'oauth', mode: 'symlink' },
            // Install/region identity, so the worker does not re-onboard.
            { relativePath: 'region', mode: 'symlink' },
            { relativePath: 'device_id', mode: 'symlink', requireOwnerOnly: true },
            // Transcript surfaces — linked THROUGH to the real home.
            { relativePath: 'sessions', mode: 'symlink' },
            { relativePath: 'session_index.jsonl', mode: 'symlink' },
        ],
    },
    /**
     * ★opencode (measured live 2026-09-19).
     *
     * ─── The gap, and the measurement that redirected the fix ───────────────
     *
     * opencode merges the global `~/.config/opencode/opencode.json` into every
     * launch alongside the project config. Like kimi this is currently DORMANT
     * (the owner's global file declares no `mcp` block — which is precisely why
     * opencode "looked isolated" in the earlier cursor investigation) and would
     * activate silently the day a global server is added.
     *
     * ★The obvious fix — `OPENCODE_CONFIG`, which names an explicit config file
     * — was measured and REJECTED. It MERGES rather than replaces:
     *
     *   XDG_CONFIG_HOME=<dir with decoy-global>  OPENCODE_CONFIG=<worker file>
     *     → `opencode mcp list` reported BOTH `decoy-global` and the worker
     *       server. 2 servers, not 1.
     *
     * Pointing a config-FILE variable at the worker config therefore isolates
     * nothing; it only adds. The config ROOT is what governs:
     *
     *   XDG_CONFIG_HOME=<dir containing only the worker server>
     *     → exactly 1 server. The decoy is gone.
     *
     * ★This is the cheapest spec of the four, because opencode splits config
     * from state: credentials live in `XDG_DATA_HOME`
     * (`~/.local/share/opencode/auth.json`), NOT in the config root. Redirecting
     * `XDG_CONFIG_HOME` therefore isolates the MCP table while leaving auth,
     * sessions and the session DB completely untouched — no imports at all, and
     * nothing to keep in sync.
     *
     * ★`XDG_CONFIG_HOME` is a SHARED variable, unlike the three provider-private
     * ones above. Redirecting it moves the config root of any other XDG-aware
     * tool the worker spawns. Accepted here because opencode offers no private
     * equivalent that REPLACES (measured above), and because the blast radius is
     * still far narrower than `HOME`: XDG_CONFIG_HOME addresses config only,
     * while `HOME` additionally carries auth, caches, sessions and shell state.
     */
    {
        providerType: 'opencode',
        homeEnvVar: 'XDG_CONFIG_HOME',
        imports: [],
        // The ISOLATED surface. Empty means the owner's global
        // `opencode.json` is absent and cannot be merged in.
        ensureDirs: ['opencode'],
    },
];

export function findWorkerPrivateHomeSpec(providerType: string): WorkerPrivateHomeSpec | null {
    const type = String(providerType || '').trim();
    if (!type) return null;
    return WORKER_PRIVATE_HOME_SPECS.find((spec) => spec.providerType === type) || null;
}
