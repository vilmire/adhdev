/**
 * The overlay — where a discovered model list meets the manifest's.
 *
 * ★P2 DECISION: A SUCCESSFUL DISCOVERY WINS, AND IT REPLACES RATHER THAN MERGES.
 *
 * The manifest is authoritative for everything about a provider EXCEPT which
 * models exist, and for that one field it is structurally incapable of being
 * right. It is a hand-written snapshot, shipped on a channel, shared by every
 * machine — while the answer it encodes is per-machine and per-account
 * (`grok models` → "You are logged in with grok.com"; `cursor-agent models` →
 * "for this account") and changes whenever a vendor ships a model. The
 * installed binary's own answer is ground truth for the only question the
 * picker is asking: "what can I select right now, here?"
 *
 * REPLACE, not merge, because drift runs both ways. Measured 2026-09-23:
 * codex's manifest listed four models the binary no longer offers
 * (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5-codex`, `gpt-5-codex-mini`). A union would
 * keep every one of them selectable forever — so the additive fix would leave
 * the actual user-visible defect (picking a model that does not exist) fully
 * intact while appearing to solve the problem.
 *
 * ★THE LIMIT OF THAT AUTHORITY — this is what keeps the trade-off honest:
 * discovery wins only when it SUCCEEDED. Every failure — not installed, signed
 * out, offline, timed out, unparseable — falls back to the manifest list
 * verbatim. The overlay can therefore never produce an EMPTY picker where the
 * manifest had entries, which is the one outcome that would be worse than
 * being stale. So the channel signature is not "bypassed": it remains the
 * floor, and discovery is only ever allowed to raise the result above it.
 *
 * ★Scope of the bypass, stated plainly: this is the single field where a local
 * runtime reading outranks signed manifest content. It is narrow by
 * construction — the overlay touches `modelOptions` and
 * `modelLaunchValueMap` and nothing else, and it can never introduce an
 * executable, a script, a path, or a permission. The manifest bytes on disk are
 * never modified (see `persist.ts`), so the channel digest still verifies.
 */
'use strict';

import type { DiscoveredModel, ModelDiscoverySnapshot } from './types.js';

/**
 * What the overlay contributes for one provider. Both fields are omitted when
 * there is nothing to say, so a spread of this object is a no-op by default.
 */
export interface ModelOverlayPatch {
    modelOptions?: string[];
    modelLaunchValueMap?: Record<string, string>;
}

/**
 * Does this provider's picker show labels rather than slugs?
 *
 * ★P1 DECISION (antigravity): keep LABELS in `modelOptions` and let
 * `modelLaunchValueMap` translate to slugs — do not switch the picker to raw
 * slugs.
 *
 * Three reasons, all load-bearing:
 *  1. The translation layer already exists and is already wired. `agy models`
 *     prints `slug<TAB>label`, which is exactly the two halves the manifest
 *     already stores as `modelOptions` (labels) + `modelLaunchValueMap`
 *     (label → slug). Discovery fills both from one read.
 *  2. NO MIGRATION OF REMEMBERED SELECTIONS. A stored choice is a label like
 *     "Gemini 3.7 Flash (High)". Keeping labels means every existing selection
 *     keeps resolving. Switching to slugs would orphan them all — and
 *     `expandModelLaunchArgs` passes unmapped values through UNCHANGED
 *     (`model-launch-args.ts:9-11`), so an orphaned label would not fail
 *     loudly; it would be handed to `agy --model "Gemini 3.7 Flash (High)"` as
 *     a model name. A silent wrong-model launch is the worst available failure
 *     mode, and it is the one the slug switch would create.
 *  3. Even a label the vendor RETIRES keeps working by that same pass-through,
 *     so the deprecation path is graceful without any migration code.
 *
 * Detected from the data rather than hardcoded per provider: a provider whose
 * manifest already maps label → slug is telling us its picker speaks labels.
 */
function picksByLabel(manifestValueMap: Record<string, string> | undefined): boolean {
    return !!manifestValueMap && Object.keys(manifestValueMap).length > 0;
}

/**
 * Build the patch for one provider.
 *
 * `snapshot` absent / non-ok / empty → `{}`, i.e. the manifest stands. This is
 * the manifest-fallback guarantee, enforced in ONE place so no caller can
 * forget it.
 */
export function buildModelOverlayPatch(
    snapshot: ModelDiscoverySnapshot | undefined,
    manifest: { modelOptions?: string[]; modelLaunchValueMap?: Record<string, string> } | undefined,
): ModelOverlayPatch {
    if (!snapshot || snapshot.status !== 'ok') return {};
    const models = Array.isArray(snapshot.models) ? snapshot.models.filter((m) => m?.slug) : [];
    // ★Never let a successful-but-empty read blank a populated picker.
    if (models.length === 0) return {};

    if (!picksByLabel(manifest?.modelLaunchValueMap)) {
        // Slug-valued picker (codex, grok, cursor, kimi, opencode): options are
        // the slugs, in the provider's own order. No value map is needed or
        // invented — an absent map means "pass the selection through".
        return { modelOptions: models.map((m) => m.slug) };
    }

    // Label-valued picker (antigravity). Options are labels; the map carries
    // label → slug. A model the CLI reports without a label falls back to its
    // slug for BOTH sides, so it stays selectable and still launches correctly.
    const options: string[] = [];
    const valueMap: Record<string, string> = {};
    for (const model of models) {
        const option = model.label || model.slug;
        if (valueMap[option]) continue; // two slugs, one label — first wins
        options.push(option);
        valueMap[option] = model.slug;
    }
    // ★Retain manifest entries for labels the CLI no longer reports. The label
    // is gone from the picker either way, but a session that REMEMBERED it
    // still resolves to the right slug instead of passing a human label to the
    // CLI. This is the graceful-deprecation half of reason 3 above.
    const merged: Record<string, string> = { ...(manifest?.modelLaunchValueMap || {}), ...valueMap };
    return { modelOptions: options, modelLaunchValueMap: merged };
}

/**
 * Resolve the model list a picker should show, given a manifest list and an
 * optional snapshot. The pure core of the read path, shared by the daemon
 * overlay and the tests that assert the fallback contract.
 */
export function resolveModelOptions(
    manifestOptions: string[] | undefined,
    snapshot: ModelDiscoverySnapshot | undefined,
    manifestValueMap?: Record<string, string>,
): string[] {
    const patch = buildModelOverlayPatch(snapshot, { modelOptions: manifestOptions, modelLaunchValueMap: manifestValueMap });
    return patch.modelOptions ?? (Array.isArray(manifestOptions) ? manifestOptions : []);
}

/** Models a snapshot reports that the manifest does not list (drift: additions). */
export function newModelsVsManifest(manifestOptions: string[] | undefined, models: DiscoveredModel[]): string[] {
    const known = new Set(manifestOptions || []);
    return models.filter((m) => !known.has(m.label || m.slug) && !known.has(m.slug)).map((m) => m.label || m.slug);
}

/** Models the manifest lists that the CLI no longer reports (drift: dead entries). */
export function deadModelsVsManifest(manifestOptions: string[] | undefined, models: DiscoveredModel[]): string[] {
    const live = new Set<string>();
    for (const model of models) {
        live.add(model.slug);
        if (model.label) live.add(model.label);
    }
    return (manifestOptions || []).filter((option) => !live.has(option));
}
