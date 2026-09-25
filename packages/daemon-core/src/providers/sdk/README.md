# Provider SDK

> License of this directory: AGPL-3.0 (part of `oss/`).

This directory is the **Provider SDK** — the contract, schemas, and daemon-side
runtime support for CLI (and ACP) providers described by a versioned manifest
(`provider.v1.json`) plus an FSM spec.

It lives **inside daemon-core**, not as a separate package, by design: the
contract definitions live next to the runtime that consumes them, eliminating
version drift. `adhdev provider init` scaffolds a new provider directly from
these modules (see `oss/packages/daemon-core/src/providers/scaffold-v1.ts` and
`packages/daemon-cloud/src/cli/provider-commands.ts`), writing out
`provider.v1.json` plus a starter `specs/1.0.json` FSM spec (and a README) for
`cli`/`acp` providers.

If you want to **author your own provider**, start with the public guide:
https://docs.adhf.dev/guide/custom-providers — it covers the manifest shape,
`~/.adhdev/providers/` drop-in override flow, and `adhdev provider init`. The
rest of this README documents the SDK's internal layout for people working on
daemon-core itself, not the authoring workflow.

## Layout

```
sdk/
  v1/                                  ← contract version 1 (current)
    types/                             ← TypeScript types for the manifest/spec contract
      cli/                             ← CLI category types
      common/                          ← shared types (settings, capabilities, auth, spawn)
    schemas/                           ← JSON Schemas backing manifest/spec validation
      cli/
        provider.schema.json           ← top-level provider.json (mirrors adhdev-providers/schemas/v1/cli/)
      acp/
      primitives/                      ← per-primitive schemas, namespaced by category
      common/
    builders/                          ← functions that turn manifest blocks into runtime handlers
      cli/
      acp/
    validators/                        ← schema check (manifest.ts), AST taint analysis (taint.ts), fixture replay (index.ts)
    sandbox/                           ← sandboxed script execution: require() whitelist + script runner for provider scripts
    fixture-tooling/                   ← PTY capture + replay utilities (format.ts, replay.ts)
```

Provider scaffolding itself (`adhdev provider init`) lives at
`oss/packages/daemon-core/src/providers/scaffold-v1.ts`, one level up from
`sdk/`, not inside this directory.

## Primitive identifiers

Primitives are referenced by `$schema: adhdev:<category>/<id>@<version>` in provider manifests. The audit-derived v1 catalog of primitives lives in the `adhdev-providers` repository at `docs/provider-contract/cli/audit-cli-v1.md` (§5), which is not part of this mirror.

## Stability

`v1/` is unstable until SDK `1.0.0` is published. Breaking changes between SDK `0.x` releases are permitted. After SDK `1.0.0`, breaking changes require an `engines.adhdev` major bump.

## Out of scope

- This SDK does not provide IDE or Extension primitives — only `cli` and `acp` are covered today.
- This SDK does not include a provider registry/marketplace server or web UI. See `docs/FROZEN_SURFACES.md` in the cloud superproject for the current (frozen) status of that plan — it is not part of this mirror.
