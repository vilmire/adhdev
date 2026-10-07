/**
 * Mesh-coordinator contracts a provider declares: how the coordinator's MCP server
 * is configured for it (auto-import / manual, file format), how delegated workers
 * are isolated and get their worker MCP delivered, the per-worker argument rules,
 * and how the coordinator system prompt is injected.
 */

export type MeshCoordinatorMcpConfigMode = 'auto_import' | 'manual' | 'none';
export type MeshCoordinatorMcpConfigFormat = 'claude_mcp_json' | 'opencode_json';

export interface ProviderMeshCoordinatorConfig {
  /** Whether ADHDev may select this provider for Repo Mesh coordinator sessions. */
  supported: boolean;
  /** Human-readable reason shown when unsupported or blocked. */
  reason?: string;
  /** How ADHDev mesh MCP tools become visible to the launched CLI. */
  mcpConfig?: {
    mode: MeshCoordinatorMcpConfigMode;
    format?: MeshCoordinatorMcpConfigFormat;
    /** Provider-relative/project-relative config path for auto-import modes, e.g. '.mcp.json'. */
    path?: string;
    /** MCP server name to materialize or display. Defaults to 'adhdev-mesh'. */
    serverName?: string;
    /** Manual setup target path/help command, e.g. 'codex mcp list'. */
    configPathCommand?: string;
    /** Whether users need a fresh CLI session after config changes. */
    requiresRestart?: boolean;
    /** User-facing setup explanation for manual modes. */
    instructions?: string;
    /** Copyable setup template. Supports {{meshId}}, {{adhdevMcpCommand}}, {{adhdevMcpArgs}}, {{workspace}}, {{serverName}}. */
    template?: string;
  };
  /**
   * How the coordinator system prompt reaches the launched CLI. Replaces the
   * old hard-coded `if (cliType === 'claude-cli') push --append-system-prompt`
   * branches in router.ts: a new CLI now ships its injection rule in its
   * provider.v1.json, no daemon code change needed. Users can override the
   * rendered prompt or the injection mechanism per-provider; if omitted, no
   * system prompt is injected (safe default — won't crash spawn with a flag
   * the CLI doesn't recognize).
   */
  systemPromptInjection?: MeshCoordinatorSystemPromptInjection;
  /**
   * Extra spawn args appended ONLY for coordinator launches (never worker or
   * interactive sessions). Use for CLI flags that pre-answer daemon-written
   * setup prompts — e.g. cursor-agent's `--approve-mcps`, which accepts the
   * daemon-written .cursor/mcp.json without parking the session on the
   * "MCP servers need to be approved" modal at coordinator startup.
   */
  launchArgs?: string[];
  /**
   * Tools the coordinator session must not have, enforced by the CLI's own
   * permission system rather than by prompt text: the coordinator routes work to
   * mesh workers instead of implementing it with local sub-agents, and must not
   * run destructive git itself. Rendered at coordinator launch only (never for
   * workers, interactive sessions or the assistant) as ONE argv
   * `<flag>=<tools joined by ','>` — e.g. claude-cli
   * `--disallowedTools=Agent,Bash(git push --force*)`. Each entry is the CLI's
   * own rule syntax; entries containing ',' or a line break are skipped.
   */
  disallowedTools?: MeshCoordinatorDisallowedTools;
  /**
   * How coordinator-launched worker sessions are isolated from coordinator-only
   * MCP/tools/config. Provider-specific CLI quirks belong here, not in daemon
   * launch code.
   */
  delegatedWorkerIsolation?: MeshCoordinatorDelegatedWorkerIsolation;
}

export interface MeshCoordinatorDisallowedTools {
  /** The CLI flag that takes a deny list, e.g. `--disallowedTools`. */
  flag: string;
  /** Deny rules in the CLI's own syntax, e.g. `Agent`, `Bash(git reset --hard*)`. */
  tools: string[];
}

export interface MeshCoordinatorDelegatedWorkerIsolation {
  /** Environment overrides applied to delegated worker sessions. */
  env?: {
    /** Environment variables to unset for delegated worker sessions. */
    unset?: string[];
    /**
     * Environment variables to SET to a concrete value for delegated worker
     * sessions. Distinct from `unset`, which writes `''` (the daemon's
     * "clear this" marker) — `set` carries a real value the worker must see.
     *
     * Values may use `{{workerHome}}`, which expands to the worker-private
     * HOME the daemon prepares for this launch. That placeholder is how a
     * home-rooted provider (antigravity) redirects its `~`-based config and
     * auth surface without daemon-core hard-coding the provider's paths.
     * A value with no placeholder is passed through verbatim.
     *
     * `unset` wins on conflict: a key named in both is cleared, never set.
     */
    set?: Record<string, string>;
  };
  /** Spawn-argument rules applied before launching a delegated worker. */
  args?: MeshCoordinatorDelegatedWorkerArgRule[];
  /**
   * How a worker MCP server is delivered when the provider cannot consume an
   * auto-import config file. The templates keep provider-specific config key
   * syntax out of daemon launch code.
   */
  workerMcpDelivery?: MeshCoordinatorWorkerMcpDelivery;
}

export interface MeshCoordinatorWorkerMcpDelivery {
  mode: 'config_override';
  /** CLI config flag, e.g. Codex's `-c`. */
  flag: string;
  /** Worker-only server name; must not reuse the coordinator server name. */
  serverName: string;
  /** Templates support {serverName}, {command_json}, {args_json}, and {env_vars_json}. */
  commandTemplate: string;
  argsTemplate: string;
  envVarsTemplate: string;
  enabledTemplate: string;
  /** Optional config override that removes the bind secret from shell children. */
  shellEnvExcludeTemplate?: string;
}

export type MeshCoordinatorDelegatedWorkerArgRule =
  | {
      mode: 'empty_mcp_config';
      /** CLI flag that points at an MCP config file, e.g. '--mcp-config'. */
      flag: string;
      /** Optional CLI flag that forces only the provided MCP config to be used. */
      strictFlag?: string;
    }
  | {
      mode: 'config_override';
      /** CLI config flag, e.g. '-c' or '--config'. */
      flag: string;
      /** Config key to set for worker isolation. */
      key: string;
      /** Config value to set. */
      value: string;
      /** Optional broader key prefix used for duplicate detection. */
      dedupeKey?: string;
      /**
       * Withhold this override when the launch has a worker-private config
       * root. For a disable-by-name rule the private root has already removed
       * the entry, so the override would CREATE an incomplete one instead of
       * disabling anything — and a CLI that validates config entries (codex
       * requires a transport) rejects the whole file and fails to start.
       * See the launch-seam comment in `cli-delegated-launch.ts` for the
       * measurement.
       */
      withholdWithPrivateHome?: boolean;
    }
  | {
      /**
       * Pre-approve the MCP servers the worker's config declares, for a CLI
       * that gates MCP startup behind a per-workspace approval allowlist.
       *
       * ★cursor-cli is the measured case (2026-09-17). Its
       * `~/.cursor/projects/<slug>/mcp-approvals.json` is keyed
       * `<serverName>-<contentHash>`; the daemon-written worker entry hashes
       * differently from anything the owner approved interactively, so cursor
       * drops it SILENTLY — no prompt, no log, just a worker with zero tools.
       * A fresh worktree has no approvals file at all, which measured the same.
       *
       * ★This flag approves EVERY server visible to the launch, so it is only
       * safe where the worker's MCP surface is already reduced to the servers
       * the daemon itself wrote. The daemon therefore refuses to apply it
       * without a worker-private HOME (`requiresPrivateHome`): without one the
       * CLI would union in the owner's personal global servers and this rule
       * would approve those too — strictly worse than not isolating at all.
       */
      mode: 'approve_mcp_servers';
      /** CLI flag that approves the launch's MCP servers, e.g. '--approve-mcps'. */
      flag: string;
      /**
       * Refuse to apply `flag` unless this launch has a worker-private HOME.
       * Defaults to true; set false only for a CLI whose approval flag is
       * scoped to an explicitly-passed config rather than everything it merges.
       */
      requiresPrivateHome?: boolean;
    };

/**
 * Declarative description of how a CLI accepts a session-scoped system prompt.
 *
 * Modes:
 *   - cli_arg          → push `flag` + prompt onto spawn args                (Claude)
 *   - config_override  → push `flag` + a templated key=value config override (Codex)
 *   - context_file     → write prompt into a workspace markdown the CLI
 *                        auto-loads as project context                       (Gemini, Antigravity)
 *   - env_var          → expose prompt to the spawned process as $name       (Hermes)
 *   - agent_file       → write prompt to a daemon-owned temp agent file and
 *                        pass its path via `flag`                            (Kimi --agent-file)
 *
 * The prompt text is templated with `{prompt}` (raw) or `{prompt_json}`
 * (JSON-encoded for embedding inside config-override strings).
 *
 * The two inline modes (cli_arg, config_override) put the whole prompt on the
 * command line. That breaks past the platform's argv limit — on win32
 * CreateProcess caps the command line at 32,767 chars and cmd.exe (npm .cmd
 * shims) at 8,191, below the coordinator prompt's size. An inline rule may
 * therefore declare `oversizeFallback`: a file-based rule the daemon uses
 * instead when the inline argument would exceed the limit. Without one the
 * launch fails with a clear error rather than an obscure spawn failure.
 * Daemons that predate the field ignore it and keep the inline behaviour.
 */
export type MeshCoordinatorSystemPromptOversizeFallback =
  | Extract<MeshCoordinatorSystemPromptNonInlineInjection, { mode: 'agent_file' }>
  | Extract<MeshCoordinatorSystemPromptNonInlineInjection, { mode: 'context_file' }>;

/** Extra spawn args applied only when the fallback is used, e.g. codex's
 *  `-c project_doc_max_bytes=…` so an AGENTS.md-delivered prompt is not
 *  truncated at the CLI's default project-doc budget. */
export type MeshCoordinatorSystemPromptFallbackRule = MeshCoordinatorSystemPromptOversizeFallback & {
  extraArgs?: string[];
};

export type MeshCoordinatorSystemPromptInjection =
  | {
      mode: 'cli_arg';
      /** Spawn-args flag, e.g. '--append-system-prompt'. The prompt becomes the next argv. */
      flag: string;
      /** File-based rule used when the inline prompt would exceed the argv limit. */
      oversizeFallback?: MeshCoordinatorSystemPromptFallbackRule;
    }
  | {
      mode: 'config_override';
      /** Spawn-args flag, e.g. '-c'. Followed by `template` with placeholders rendered. */
      flag: string;
      /** Template using {prompt} or {prompt_json}, e.g. 'developer_instructions={prompt_json}'. */
      template: string;
      /** File-based rule used when the inline prompt would exceed the argv limit. */
      oversizeFallback?: MeshCoordinatorSystemPromptFallbackRule;
    }
  | MeshCoordinatorSystemPromptNonInlineInjection;

/** Injection rules that keep the prompt body off the command line. */
export type MeshCoordinatorSystemPromptNonInlineInjection =
  | {
      mode: 'context_file';
      /** Workspace-relative file path the CLI auto-loads, e.g. 'AGENTS.md' or 'GEMINI.md'. */
      path: string;
      /**
       * Optional wrapper around the prompt. Use `{prompt}` placeholder. Existing
       * wrapper-delimited blocks are replaced rather than duplicated, so re-launching
       * a coordinator doesn't pile up copies. If omitted, the prompt is appended raw.
       */
      wrapper?: string;
      /**
       * When true the daemon owns the whole file (a dedicated, daemon-named
       * file such as `.cursor/rules/adhdev-mesh-coordinator.mdc`), so cleanup
       * DELETES the file outright instead of stripping the wrapper block out
       * of user-authored content. Default false (shared user file — strip).
       */
      owned?: boolean;
    }
  | {
      mode: 'env_var';
      /** Env-var name, e.g. 'HERMES_EPHEMERAL_SYSTEM_PROMPT'. */
      name: string;
    }
  | {
      mode: 'agent_file';
      /** Spawn-args flag that accepts an agent-file path, e.g. '--agent-file' (kimi). */
      flag: string;
      /**
       * Agent-file body template using the {prompt} placeholder; defaults to
       * '{prompt}'. CLI-native template variables (e.g. kimi's ${base_prompt})
       * pass through verbatim — only {prompt} is substituted by the daemon.
       * The file is written under a daemon-owned temp dir, never the workspace.
       */
      template?: string;
    };
