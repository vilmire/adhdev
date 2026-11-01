/**
 * Owner-upload capture at the dashboard send ingress (mission ed23a6a1).
 *
 * `send_chat` calls this for every CLI chat submit. It acts ONLY when all hold:
 *   - the router-stamped source is `p2p`/`standalone` AND the args carry a live
 *     trusted-owner proof (a payload field or unverified no-auth dashboard
 *     cannot mint an upload),
 *   - the target is the registry-bound assistant session,
 *   - the envelope carries inline image bytes.
 * Each valid image is staged as a mesh-less owner artifact (artifacts/owner-upload.ts)
 * and the assistant is told its artifact id in the delivered text, so it can later
 * pass `attachments:[id]` to `project_send`. Capture is best-effort: a refusal
 * or a store failure never blocks the chat (the image still reaches the
 * assistant natively) and is reported to the assistant instead.
 */

import * as path from 'node:path';
import { ArtifactStore } from '../artifacts/artifact-store.js';
import { OWNER_UPLOAD_ATTACH_TTL_MS, stageOwnerUploads } from '../artifacts/owner-upload.js';
import { getAssistantRegistry } from '../assistant/assistant-registry.js';
import { getConfigDir } from '../config/config.js';
import { LOG } from '../logging/logger.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import type { InputEnvelope } from '../providers/contracts.js';
import { isTrustedOwnerIngress, readCommandSource, readUnverifiedDashboardInput } from './command-args.js';

export function ownerUploadRootDir(): string {
    return path.join(getConfigDir(), 'owner-uploads');
}

/** The text appended to the assistant's delivered input, or null when nothing was captured. */
export function captureOwnerUploads(args: unknown, sessionKey: string, messageId: string, input: InputEnvelope): string | null {
    try {
        const source = readCommandSource(args);
        if ((source !== 'p2p' && source !== 'standalone') || readUnverifiedDashboardInput(args) || !isTrustedOwnerIngress(args, source)) return null;
        const bound = getAssistantRegistry().read()?.sessionId;
        const requested = typeof (args as { targetSessionId?: unknown })?.targetSessionId === 'string' ? (args as { targetSessionId: string }).targetSessionId.trim() : '';
        if (!bound || (bound !== sessionKey && bound !== requested)) return null;
        const images = input.parts
            .map((part, index) => ({ part, index }))
            .filter((x): x is { part: Extract<typeof x.part, { type: 'image' }>; index: number } => x.part.type === 'image' && typeof x.part.data === 'string' && x.part.data.length > 0)
            .map(({ part, index }) => ({ index, mimeType: part.mimeType, data: part.data as string }));
        if (images.length === 0) return null;
        const store = new ArtifactStore(MeshRuntimeStore.getInstance().db);
        const staged = stageOwnerUploads(store, { rootDir: ownerUploadRootDir(), assistantSessionId: bound, ownerMessageId: messageId, images });
        const lines: string[] = [];
        for (const item of staged.imported) {
            lines.push(`Owner upload ${item.index + 1} is project artifact ${item.artifactId} (${item.mime}, ${item.sizeBytes} bytes). To send it to a project, call project_send with attachments: ["${item.artifactId}"] (valid ${OWNER_UPLOAD_ATTACH_TTL_MS / 60000} minutes).`);
        }
        for (const item of staged.refused) {
            lines.push(`Owner image ${item.index + 1} cannot be forwarded as a project artifact (${item.code}); it was still delivered to you as a normal image.`);
        }
        return lines.length > 0 ? `[${lines.join('\n')}]` : null;
    } catch (error) {
        LOG.warn('OwnerUpload', `capture failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/** A copy of the envelope whose native delivery text ends with `note`; logical receipt identity is untouched. */
export function withOwnerUploadNote(input: InputEnvelope, note: string): InputEnvelope {
    const hasText = input.parts.some((part) => part.type === 'text' && part.text.trim());
    return {
        ...input,
        textFallback: input.textFallback ? `${input.textFallback}\n\n${note}` : note,
        parts: [...input.parts, { type: 'text' as const, text: hasText ? `\n\n${note}` : note }],
    };
}
