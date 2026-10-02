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
    "id": "antigravity-cli",
    "name": "Antigravity CLI",
    "icon": "🪐"
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
    "id": "grok-cli",
    "name": "Grok",
    "icon": "🛰️"
  },
  {
    "id": "kimi",
    "name": "Kimi",
    "icon": "🌙"
  },
  {
    "id": "opencode",
    "name": "OpenCode CLI",
    "icon": "◆"
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
  },
  {
    "id": "claude-code-vscode",
    "name": "Claude Code (VS Code)",
    "icon": "🟠"
  }
]

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
    "testedOn": [],
    "testedVersions": [],
    "validatedFlows": [],
    "lastValidated": null,
    "notes": "",
    "evidence": "",
    "owner": "community",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "cursor": {
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
  "antigravity-cli": {
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
    "status": "verified",
    "testedOn": [
      "macOS",
      "Windows",
      "Linux"
    ],
    "testedVersions": [
      "Claude Code 2.1.220"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resolve_action",
      "resume",
      "stop",
      "mesh_worker"
    ],
    "lastValidated": "2026-10-03",
    "notes": "Maintainer's daily driver; also exercised as Repo Mesh coordinator/worker.",
    "evidence": "Daily use across three OSes; 2026-10-02/03 launch rehearsal (standalone mesh rounds 1–4).",
    "owner": "maintainer",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "codex-cli": {
    "status": "verified",
    "testedOn": [
      "macOS",
      "Windows",
      "Linux"
    ],
    "testedVersions": [
      "codex-cli 0.156.1"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resolve_action",
      "resume",
      "stop",
      "mesh_worker"
    ],
    "lastValidated": "2026-10-03",
    "notes": "Maintainer's daily driver; also exercised as Repo Mesh coordinator/worker.",
    "evidence": "Daily use across three OSes; 2026-10-02/03 launch rehearsal (standalone mesh rounds 1–4).",
    "owner": "maintainer",
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
  "grok-cli": {
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
  "kimi": {
    "status": "verified",
    "testedOn": [
      "macOS",
      "Windows",
      "Linux"
    ],
    "testedVersions": [
      "Kimi Code 2.1.1"
    ],
    "validatedFlows": [
      "launch",
      "send_chat",
      "read_chat",
      "resolve_action",
      "resume",
      "stop",
      "mesh_worker"
    ],
    "lastValidated": "2026-10-03",
    "notes": "Maintainer's daily driver; also exercised as Repo Mesh coordinator/worker.",
    "evidence": "Daily use across three OSes; 2026-10-02/03 launch rehearsal (standalone mesh rounds 1–4).",
    "owner": "maintainer",
    "source": "docs/site/data/provider-catalog.mjs"
  },
  "opencode": {
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
  "claude-code-vscode": {
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
  "cursor": "unverified",
  "kiro": "unverified",
  "pearai": "unverified",
  "trae": "unverified",
  "vscode": "unverified",
  "vscodium": "unverified",
  "windsurf": "unverified",
  "antigravity-cli": "unverified",
  "claude-cli": "verified",
  "codex-cli": "verified",
  "cursor-cli": "unverified",
  "grok-cli": "unverified",
  "kimi": "verified",
  "opencode": "unverified",
  "cline": "unverified",
  "codex": "unverified",
  "roo-code": "unverified",
  "claude-code-vscode": "unverified"
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
  },
  {
    "id": "claude-code-vscode",
    "name": "Claude Code (VS Code)",
    "category": "extension",
    "targetStatus": "partial",
    "priority": 4,
    "rationale": "Official Anthropic VS Code extension; cloud dashboards should surface it alongside other extension agents once CDP webview flows are validated.",
    "requiredFlows": [
      "read_chat",
      "new_session",
      "send_chat",
      "list_sessions",
      "switch_session"
    ],
    "optionalFlows": [
      "resolve_action"
    ],
    "notes": "Validate with DevServer and explicit managerKey when multiple IDE windows are attached."
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
