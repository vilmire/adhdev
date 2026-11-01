/**
 * Owner-upload image validation (mission ed23a6a1).
 *
 * Dependency-free byte-level checks for an image the owner attached in the
 * assistant chat, run BEFORE anything is written or registered. MIME and
 * extension alone do not prove valid raster bytes, so the container signature
 * is checked and the pixel dimensions are read from the header (bounded, no
 * decode). Only PNG / JPEG / WebP / GIF are accepted — SVG and HTML are
 * refused by construction (no signature matches them).
 */

import { createHash } from 'node:crypto';
import { MAX_ARTIFACT_BYTES, maxBase64EncodedBytes } from './types.js';

export const OWNER_UPLOAD_MAX_FILES = 5;
export const OWNER_UPLOAD_MAX_FILE_BYTES = MAX_ARTIFACT_BYTES;
export const OWNER_UPLOAD_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const OWNER_UPLOAD_MAX_EDGE = 16_384;
export const OWNER_UPLOAD_MAX_PIXELS = 40_000_000;

export type OwnerUploadImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const EXT_BY_MIME: Readonly<Record<OwnerUploadImageMime, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

export type OwnerUploadRefusalCode =
    | 'upload_invalid_encoding'
    | 'upload_too_large'
    | 'upload_empty'
    | 'upload_unsupported_type'
    | 'upload_type_mismatch'
    | 'upload_corrupt_image'
    | 'upload_dimensions_exceeded';

export interface ValidatedOwnerUploadImage {
    ok: true;
    bytes: Buffer;
    mime: OwnerUploadImageMime;
    ext: string;
    sha256: string;
    width: number;
    height: number;
}

export interface RefusedOwnerUploadImage {
    ok: false;
    code: OwnerUploadRefusalCode;
    error: string;
}

const refuse = (code: OwnerUploadRefusalCode, error: string): RefusedOwnerUploadImage => ({ ok: false, code, error });

interface Dimensions { width: number; height: number }

function sniffMime(b: Buffer): OwnerUploadImageMime | null {
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6) {
        const head = b.subarray(0, 6).toString('latin1');
        if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
    }
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

function pngDimensions(b: Buffer): Dimensions | null {
    // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
    if (b.length < 24 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifDimensions(b: Buffer): Dimensions | null {
    if (b.length < 10) return null;
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegDimensions(b: Buffer): Dimensions | null {
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i += 1; continue; }
        const marker = b[i + 1];
        if (marker === 0xff) { i += 1; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (len < 2) return null;
        // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
    }
    return null;
}

function webpDimensions(b: Buffer): Dimensions | null {
    if (b.length < 30) return null;
    const fourcc = b.subarray(12, 16).toString('latin1');
    if (fourcc === 'VP8X') {
        return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (fourcc === 'VP8L') {
        if (b[20] !== 0x2f) return null;
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (fourcc === 'VP8 ') {
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    return null;
}

const DIMENSION_READERS: Readonly<Record<OwnerUploadImageMime, (b: Buffer) => Dimensions | null>> = {
    'image/png': pngDimensions,
    'image/jpeg': jpegDimensions,
    'image/gif': gifDimensions,
    'image/webp': webpDimensions,
};

/** Canonical base64 → bytes with the size checked BEFORE any allocation. */
export function decodeOwnerUploadBase64(data: unknown): { ok: true; bytes: Buffer } | RefusedOwnerUploadImage {
    if (typeof data !== 'string') return refuse('upload_invalid_encoding', 'image data must be a base64 string');
    const stripped = data.replace(/^data:[^;,]*;base64,/i, '');
    if (stripped.length === 0) return refuse('upload_empty', 'image data is empty');
    if (stripped.length > maxBase64EncodedBytes(OWNER_UPLOAD_MAX_FILE_BYTES)) {
        return refuse('upload_too_large', `image exceeds ${OWNER_UPLOAD_MAX_FILE_BYTES} bytes`);
    }
    if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
        return refuse('upload_invalid_encoding', 'image data is not canonical base64');
    }
    const bytes = Buffer.from(stripped, 'base64');
    if (bytes.length === 0) return refuse('upload_empty', 'image data is empty');
    if (bytes.length > OWNER_UPLOAD_MAX_FILE_BYTES) return refuse('upload_too_large', `image exceeds ${OWNER_UPLOAD_MAX_FILE_BYTES} bytes`);
    return { ok: true, bytes };
}

/** Validate decoded bytes against an optional declared MIME type. */
export function validateOwnerUploadBytes(bytes: Buffer, declaredMime?: string): ValidatedOwnerUploadImage | RefusedOwnerUploadImage {
    if (bytes.length === 0) return refuse('upload_empty', 'image data is empty');
    if (bytes.length > OWNER_UPLOAD_MAX_FILE_BYTES) return refuse('upload_too_large', `image exceeds ${OWNER_UPLOAD_MAX_FILE_BYTES} bytes`);
    const sniffed = sniffMime(bytes);
    if (!sniffed) return refuse('upload_unsupported_type', 'only PNG, JPEG, WebP and GIF images can be forwarded');
    const declared = typeof declaredMime === 'string' ? declaredMime.trim().toLowerCase().replace('image/jpg', 'image/jpeg') : '';
    if (declared && declared !== sniffed) {
        return refuse('upload_type_mismatch', `declared ${declaredMime} but the bytes are ${sniffed}`);
    }
    const dims = DIMENSION_READERS[sniffed](bytes);
    if (!dims || dims.width < 1 || dims.height < 1) return refuse('upload_corrupt_image', 'image header is malformed');
    if (dims.width > OWNER_UPLOAD_MAX_EDGE || dims.height > OWNER_UPLOAD_MAX_EDGE || dims.width * dims.height > OWNER_UPLOAD_MAX_PIXELS) {
        return refuse('upload_dimensions_exceeded', 'image dimensions exceed the forwarding limit');
    }
    return {
        ok: true,
        bytes,
        mime: sniffed,
        ext: EXT_BY_MIME[sniffed],
        sha256: createHash('sha256').update(bytes).digest('hex'),
        width: dims.width,
        height: dims.height,
    };
}

export function validateOwnerUploadImage(input: { mimeType?: string; data: unknown }): ValidatedOwnerUploadImage | RefusedOwnerUploadImage {
    const decoded = decodeOwnerUploadBase64(input.data);
    if (!decoded.ok) return decoded;
    return validateOwnerUploadBytes(decoded.bytes, input.mimeType);
}
