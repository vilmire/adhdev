/**
 * Built-in provider inventory
 *
 * Generated from docs/site/data/provider-catalog.mjs via docs/site/scripts/sync-doc-stats.mjs.
 * Built-in inventory is not the same thing as verified support.
 */

export interface SupportedEntry {
  id: string
  name: string
  icon: string
}

export interface ProviderVerificationMap {
  [providerId: string]: ProviderVerification
}

export type ProviderVerificationStatus = 'verified' | 'partial' | 'unverified'

export interface ProviderVerification {
  status: ProviderVerificationStatus
  testedOn: string[]
  testedVersions: string[]
  validatedFlows: string[]
  lastValidated: string | null
  notes: string
  evidence: string
  owner: string
  source: string
}

export interface VerificationCandidate {
  id: string
  name: string
  category: string
  targetStatus: ProviderVerificationStatus
  priority: number
  rationale: string
  requiredFlows: string[]
  optionalFlows: string[]
  notes: string
}

export const BUILTIN_IDES: readonly SupportedEntry[] = [
  {
    "id": "antigravity",
    "name": "Antigravity",
    "icon": "🌀"
  },
  {
    "id": "cursor",
    "name": "Cursor",
    "icon": "⚡"
  },
  {
    "id": "kiro",
    "name": "Kiro",
    "icon": "🎯"
  },
  {
    "id": "pearai",
    "name": "PearAI",
    "icon": "🍐"
  },
  {
    "id": "trae",
    "name": "Trae",
    "icon": "🔮"
  },
  {
    "id": "vscode",
    "name": "VS Code",
    "icon": "💙"
  },
  {
    "id": "vscodium",
    "name": "VSCodium",
    "icon": "💚"
  },
  {
    "id": "windsurf",
    "name": "Windsurf",
    "icon": "🏄"
  }
]

export const BUILTIN_CLI_AGENTS: readonly SupportedEntry[] = [
  {
    "id": "aider-cli",
    "name": "Aider",
    "icon": "🛠️"
  },
  {
    "id": "claude-cli",
    "name": "Claude Code",
    "icon": "🟠"
  },
  {
    "id": "codex-cli",
    "name": "Codex CLI",
    "icon": "📦"
  },
  {
    "id": "cursor-cli",
    "name": "Cursor CLI",
    "icon": "⚡"
  },
  {
    "id": "gemini-cli",
    "name": "Gemini CLI",
    "icon": "✨"
  },
  {
    "id": "github-copilot-cli",
    "name": "GitHub Copilot CLI",
    "icon": "🤖"
  },
  {
    "id": "goose-cli",
    "name": "Goose",
    "icon": "🪿"
  },
  {
    "id": "opencode-cli",
    "name": "OpenCode CLI",
    "icon": "🧩"
  }
]

export const BUILTIN_EXTENSIONS: readonly SupportedEntry[] = [
  {
    "id": "cline",
    "name": "Cline",
    "icon": "🧠"
  },
  {
    "id": "codex",
    "name": "Codex",
    "icon": "📦"
  },
  {
    "id": "roo-code",
    "name": "Roo Code",
    "icon": "🦘"
  }
]

export const BUILTIN_ACP_COUNT = 35

export const DEFAULT_PROVIDER_VERIFICATION: ProviderVerification = {
  "status": "unverified",
  "testedOn": [],
  "testedVersions": [],
  "validatedFlows": [],
  "lastValidated": null,
  "notes": "",
  "evidence": "",
  "owner": "community",
  "source": "docs/site/data/provider-catalog.mjs"
}

export const PROVIDER_VERIFICATION: ProviderVerificationMap = {
  "antigravity": {
    "status": "unverified",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "Antigravity 1.22.2"
    ],
    "validatedFlows": [
      "read_chat",
      "list_sessions"
    ],
    "lastValidated": "2026-04-09",
    "notes": "Local smoke test confirmed read_chat and list_sessions. A fresh new_session plus send_chat flow did not produce a readable conversation transcript, so promotion is blocked.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cursor": {
    "status": "partial",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "Cursor 3.0.13"
    ],
    "validatedFlows": [
      "detect",
      "launch",
      "read_chat",
      "send_chat",
      "list_sessions",
      "switch_session",
      "new_session",
      "list_models",
      "list_modes"
    ],
    "lastValidated": "2026-04-09",
    "notes": "Detection, launch, fresh new-session send/read, session listing, session switching, model listing, and mode listing were validated locally. The tested build currently exposes only Auto in the model picker, and set_model plus resolve_action remain unverified.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "kiro": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "pearai": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "trae": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "vscode": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "vscodium": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "windsurf": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "aider-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "claude-cli": {
    "status": "partial",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "Claude Code 2.1.84"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resume",
      "reconnect",
      "stop"
    ],
    "lastValidated": "2026-04-09",
    "notes": "Saved-session listing, resume launch, daemon-restart reconnect, and live read_chat were confirmed locally. A parser false-positive that trimmed short exact-match answers as prompt echo was fixed during validation; the provider still remains partial until more than one app/version combination is covered.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "codex-cli": {
    "status": "unverified",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "codex-cli 0.118.0"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resume",
      "stop"
    ],
    "lastValidated": "2026-04-09",
    "notes": "Saved-session resume works locally, but reconnect after daemon or transport disruption is still unverified. Fresh launch still lands in an onboarding-style prompt state often enough that exact-answer send/read validation is not yet trustworthy.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cursor-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "gemini-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "github-copilot-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "goose-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "opencode-cli": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cline": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "codex": {
    "status": "partial",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "openai.chatgpt 26.406.31014"
    ],
    "validatedFlows": [
      "read_chat",
      "new_session",
      "send_chat"
    ],
    "lastValidated": "2026-04-09",
    "notes": "A fresh Codex extension chat could be created and answered correctly inside Antigravity. The current provider surface still does not expose dedicated list_sessions or switch_session scripts, and extension history listing remains empty in local validation.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "roo-code": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "agentpool-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "amp-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "auggie-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "autodev-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "autohand-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "blackbox-ai-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "claude-agent-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cline-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "codebuddy-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "codex-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "corust-agent-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "crow-cli-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cursor-acp": {
    "status": "partial",
    "testedOn": [
      "macOS 26.4"
    ],
    "testedVersions": [
      "cursor-agent 2026.03.25-933d5a6"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resolve_action",
      "list_models",
      "set_model",
      "list_modes",
      "set_mode",
      "stop"
    ],
    "lastValidated": "2026-04-09",
    "notes": "Approval flow, model change, mode change, and hard stop were validated locally. Reconnect and session resume are still unverified.",
    "evidence": "Manual local validation via standalone API on 2026-04-09",
    "owner": "core",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "deepagents-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "dimcode-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "docker-cagent-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "factory-droid-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "fast-agent-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "gemini-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "github-copilot-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "goose-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "junie-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "kilo-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "kimi-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "minion-code-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "mistral-vibe-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "nova-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "openclaw-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "opencode-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "openhands-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "pi-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "qoder-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "qwen-code-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "stakpak-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "vtcode-acp": {
    "status": "unverified",
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  }
}

export const PROVIDER_VERIFICATION_STATUS: Record<string, ProviderVerificationStatus> = {
  "antigravity": "unverified",
  "cursor": "partial",
  "kiro": "unverified",
  "pearai": "unverified",
  "trae": "unverified",
  "vscode": "unverified",
  "vscodium": "unverified",
  "windsurf": "unverified",
  "aider-cli": "unverified",
  "claude-cli": "partial",
  "codex-cli": "unverified",
  "cursor-cli": "unverified",
  "gemini-cli": "unverified",
  "github-copilot-cli": "unverified",
  "goose-cli": "unverified",
  "opencode-cli": "unverified",
  "cline": "unverified",
  "codex": "partial",
  "roo-code": "unverified",
  "agentpool-acp": "unverified",
  "amp-acp": "unverified",
  "auggie-acp": "unverified",
  "autodev-acp": "unverified",
  "autohand-acp": "unverified",
  "blackbox-ai-acp": "unverified",
  "claude-agent-acp": "unverified",
  "cline-acp": "unverified",
  "codebuddy-acp": "unverified",
  "codex-acp": "unverified",
  "corust-agent-acp": "unverified",
  "crow-cli-acp": "unverified",
  "cursor-acp": "partial",
  "deepagents-acp": "unverified",
  "dimcode-acp": "unverified",
  "docker-cagent-acp": "unverified",
  "factory-droid-acp": "unverified",
  "fast-agent-acp": "unverified",
  "gemini-acp": "unverified",
  "github-copilot-acp": "unverified",
  "goose-acp": "unverified",
  "junie-acp": "unverified",
  "kilo-acp": "unverified",
  "kimi-acp": "unverified",
  "minion-code-acp": "unverified",
  "mistral-vibe-acp": "unverified",
  "nova-acp": "unverified",
  "openclaw-acp": "unverified",
  "opencode-acp": "unverified",
  "openhands-acp": "unverified",
  "pi-acp": "unverified",
  "qoder-acp": "unverified",
  "qwen-code-acp": "unverified",
  "stakpak-acp": "unverified",
  "vtcode-acp": "unverified"
}

export const VERIFICATION_CANDIDATES: readonly VerificationCandidate[] = [
  {
    "id": "codex-cli",
    "name": "Codex CLI",
    "category": "cli",
    "targetStatus": "partial",
    "priority": 1,
    "rationale": "High-traffic PTY provider and strongest remaining candidate for session resume validation.",
    "requiredFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resume",
      "reconnect",
      "stop"
    ],
    "optionalFlows": [
      "resolve_action"
    ],
    "notes": "Promotion should include saved-session ID extraction and restart/reconnect behavior, not only one-shot chat."
  },
  {
    "id": "cursor",
    "name": "Cursor",
    "category": "ide",
    "targetStatus": "verified",
    "priority": 2,
    "rationale": "Primary desktop IDE path now has partial evidence and needs deeper control-surface validation.",
    "requiredFlows": [
      "list_models",
      "set_model",
      "list_modes",
      "set_mode",
      "resolve_action"
    ],
    "optionalFlows": [
      "reconnect",
      "stop"
    ],
    "notes": "Move from partial to verified only after model switching and approval handling are stable on a pinned app version."
  },
  {
    "id": "codex",
    "name": "Codex",
    "category": "extension",
    "targetStatus": "verified",
    "priority": 3,
    "rationale": "Extension flow is usable, but its session-history surface is still materially narrower than other extension providers.",
    "requiredFlows": [
      "read_chat",
      "new_session",
      "send_chat",
      "list_sessions",
      "switch_session"
    ],
    "optionalFlows": [
      "set_model",
      "set_mode",
      "resolve_action"
    ],
    "notes": "Promotion should wait until the provider exposes session history and switching in a first-class way instead of relying on empty extension history responses."
  }
]

export function getProviderVerification(providerId: string): ProviderVerification {
  return PROVIDER_VERIFICATION[providerId] || DEFAULT_PROVIDER_VERIFICATION
}

export function getProviderVerificationStatus(providerId: string): ProviderVerificationStatus {
  return getProviderVerification(providerId).status
}

/**
 * @deprecated Use BUILTIN_IDES instead.
 */
export const SUPPORTED_IDES = BUILTIN_IDES
/**
 * @deprecated Use BUILTIN_CLI_AGENTS instead.
 */
export const SUPPORTED_CLI_AGENTS = BUILTIN_CLI_AGENTS
/**
 * @deprecated Use BUILTIN_EXTENSIONS instead.
 */
export const SUPPORTED_EXTENSIONS = BUILTIN_EXTENSIONS
/**
 * @deprecated Use BUILTIN_ACP_COUNT instead.
 */
export const SUPPORTED_ACP_COUNT = BUILTIN_ACP_COUNT
