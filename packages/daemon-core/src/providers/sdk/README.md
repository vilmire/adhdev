# Provider SDK

> Status: Phase 1 in progress · License of this directory: AGPL-3.0 (part of `oss/`) · See [marketplace plan](../../../../../../docs/design/v1.0.0-marketplace-plan.md).

This directory is the **Provider SDK** — the framework that lets external developers author CLI providers (and later IDE, Extension, ACP) against a versioned, typed contract.

It lives **inside daemon-core**, not as a separate package, by design:

- the contract definitions live next to the runtime that consumes them, eliminating version drift
- `adhdev provider *` CLI commands call straight into these modules
- two npm packages are extracted from this source at build time:
  - `@adhdev/provider-types` (Apache 2.0) — TypeScript types for external authors
  - `@adhdev/provider-schemas` (Apache 2.0) — JSON Schemas for editor support

## Layout

```
sdk/
  v1/                                  ← contract version 1 (current)
    types/                             ← TypeScript types — extracted to @adhdev/provider-types
      cli/                             ← CLI category types
      common/                          ← shared types (settings, capabilities, auth, spawn)
    schemas/                           ← JSON Schemas — extracted to @adhdev/provider-schemas
      cli/
        provider.schema.json           ← top-level provider.json (mirrors adhdev-providers/schemas/v1/cli/)
      primitives/                      ← per-primitive schemas, namespaced by category
      common/
    primitives/                        ← daemon-side primitive implementations
      cli/                             ← TUI primitives, native-history adapters, capability handlers
    builders/                          ← functions that turn manifest blocks into runtime handlers
    validators/                        ← schema check, AST taint analysis, fixture replay
    scaffolders/                       ← `adhdev provider init` templates
    fixture-tooling/                   ← PTY capture + replay utilities
  v2/                                  ← reserved for next contract major
```

## Primitive identifiers

Primitives are referenced by `$schema: adhdev:<category>/<id>@<version>` in provider manifests. See the audit-derived v1 catalog of 50 primitives at [`audit-cli-v1.md §5`](../../../../../../../adhdev-providers/docs/provider-contract/cli/audit-cli-v1.md#5-proposed-v1-primitive-set).

## Stability

`v1/` is unstable until SDK `1.0.0` is published. Breaking changes between SDK `0.x` releases are permitted during Phase 1-2 migration. After SDK `1.0.0`, breaking changes require an `engines.adhdev` major bump.

## Out of scope

- This SDK does not provide IDE, Extension, or ACP primitives in v1.0.0. They follow in v1.1+.
- This SDK does not include the registry server code — that lives in [`oss/packages/registry/`](../../../../../registry/) (not yet created).
- This SDK does not include the marketplace web UI — that lives separately.
