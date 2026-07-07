# Security Policy

## Supported Versions

Only the latest minor release line of each published package receives security
fixes. Older versions should upgrade to the latest release.

| Version | Supported |
|---------------------------|-----------|
| Latest minor (e.g. `x.Y.*` newest) | ✅ |
| Older releases | ❌ |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via public GitHub issues,
discussions, or pull requests.**

Preferred channel:

1. **GitHub private vulnerability reporting** — use
   ["Report a vulnerability"](https://github.com/vilmire/adhdev/security/advisories/new)
   on this repository (Security tab → Advisories → Report a vulnerability).
2. **Email (alternative)** — **support@adhf.dev**

Please include:

- Description of the vulnerability
- Steps to reproduce (proof of concept if possible)
- Potential impact
- Affected package(s) and version(s)
- Suggested fix (optional)

## Response Targets

- Initial response within **48 hours**.
- We aim to release patches within **7 days** of confirmation.
- We will coordinate disclosure timing with you before publishing details.

## Scope

This policy covers the open-source packages in this repository:

- `packages/daemon-core` — shared daemon engine (providers, CDP, command routing)
- `packages/daemon-standalone` — self-hosted HTTP/WS server on `localhost:3847`
- `packages/mcp-server` — MCP stdio server bridge
- `packages/mesh-shared` — shared mesh types/helpers
- `packages/web-core` — shared UI components, hooks, types
- `packages/web-standalone` — self-hosted dashboard
- `packages/web-devconsole` — provider dev console
- `packages/session-host-core` / `packages/session-host-daemon` — session host runtime
- `packages/terminal-mux-*` / `packages/terminal-render-web` — terminal mux stack
- `packages/ghostty-vt-node` — ghostty VT bindings

## Out of Scope

- The hosted cloud service (`adhf.dev`, `api.adhf.dev`) and proprietary cloud
  packages — still report these privately to **support@adhf.dev**, but they are
  tracked outside this repository
- Issues in third-party dependencies (report to the upstream project)
- Deployments that intentionally disable the built-in protections (e.g. binding
  standalone to non-localhost interfaces with no token and no dashboard
  password after acknowledging the warning)
- Social engineering attacks
- Physical access attacks
