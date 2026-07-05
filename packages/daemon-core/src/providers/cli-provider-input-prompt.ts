/**
 * CLI provider structured-input helpers — image materialization + prompt build.
 *
 * Pure move out of cli-provider-instance.ts (no behavior change): the input
 * envelope → CLI prompt string construction and its image-materialization
 * support. cli-provider-instance re-exports buildCliStructuredInputPrompt so
 * existing importers/tests keep their path.
 */

import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { type InputEnvelope, type InputPart } from './contracts.js';

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
};

function filePathFromUri(uri: string): string | null {
    if (!uri) return null;
    if (uri.startsWith('file://')) {
        try {
            return decodeURIComponent(new URL(uri).pathname);
        } catch {
            return uri.slice('file://'.length);
        }
    }
    if (path.isAbsolute(uri)) return uri;
    return null;
}

function extensionForImageMime(mimeType: string): string {
    return IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()] || '.img';
}

function safeInputImageBasename(index: number, mimeType: string): string {
    const extension = extensionForImageMime(mimeType);
    const suffix = crypto.randomBytes(6).toString('hex');
    return `adhdev-input-image-${Date.now()}-${index}-${suffix}${extension}`;
}

function materializeImageDataPart(part: Extract<InputPart, { type: 'image' }>, index: number, dir: string): string | null {
    if (!part.data) return null;
    const rawData = part.data.includes(',') ? part.data.split(',').pop() || '' : part.data;
    if (!rawData) return null;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, safeInputImageBasename(index, part.mimeType));
    fs.writeFileSync(filePath, Buffer.from(rawData, 'base64'));
    cleanupStaleMaterializedImages(dir);
    return filePath;
}

const MATERIALIZED_IMAGE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const MATERIALIZED_IMAGE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastMaterializedImageCleanupAt = 0;

function cleanupStaleMaterializedImages(dir: string): void {
    const now = Date.now();
    if (now - lastMaterializedImageCleanupAt < MATERIALIZED_IMAGE_CLEANUP_INTERVAL_MS) return;
    lastMaterializedImageCleanupAt = now;
    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (!entry.startsWith('adhdev-input-image-')) continue;
            const fullPath = path.join(dir, entry);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > MATERIALIZED_IMAGE_MAX_AGE_MS) {
                    fs.unlinkSync(fullPath);
                }
            } catch { /* file may have been removed concurrently */ }
        }
    } catch { /* dir may not exist or be inaccessible */ }
}

export function buildCliStructuredInputPrompt(
    input: InputEnvelope,
    options: { materializeDir?: string } = {},
): string {
    const promptParts: string[] = [];
    const imageRefs: string[] = [];
    const resourceRefs: string[] = [];
    const materializeDir = options.materializeDir || path.join(os.tmpdir(), 'adhdev-input-media');

    input.parts.forEach((part, index) => {
        if (part.type === 'text' && part.text.trim()) {
            promptParts.push(part.text.trim());
            return;
        }

        if (part.type === 'image') {
            const localPath = typeof part.uri === 'string' ? filePathFromUri(part.uri) : null;
            const materializedPath = !localPath && part.data ? materializeImageDataPart(part, index, materializeDir) : null;
            const ref = localPath || materializedPath || part.uri || '';
            if (ref) imageRefs.push(ref);
            if (part.alt?.trim()) promptParts.push(part.alt.trim());
            return;
        }

        if (part.type === 'resource_link') {
            resourceRefs.push([part.title, part.name, part.description, part.uri].filter(Boolean).join('\n'));
            return;
        }

        if (part.type === 'resource') {
            resourceRefs.push([part.name, part.text, part.uri].filter(Boolean).join('\n'));
        }
    });

    // Only use textFallback when no explicit text parts were collected — it is
    // the flattened version of the same parts, so appending it alongside them
    // would duplicate the content for multipart inputs.
    const hasExplicitTextParts = input.parts.some((part) => part.type === 'text' && part.text.trim());
    if (!hasExplicitTextParts && input.textFallback.trim()) {
        promptParts.push(input.textFallback.trim());
    }

    const ordered = [
        ...imageRefs,
        ...promptParts,
        ...resourceRefs,
    ].filter((value, index, values) => value.trim().length > 0 && values.indexOf(value) === index);

    return ordered.join('\n');
}
