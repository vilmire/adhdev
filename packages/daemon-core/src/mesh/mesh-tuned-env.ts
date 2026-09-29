

/** `process.env[envName]` as an integer in [min, max], else `def`. */
import { readText } from '@adhdev/mesh-shared';
export function resolveTunedReconcileMs(envName: string, def: number, min: number, max: number): number {
    const raw = readText(process.env[envName]);
    if (raw) {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= min && parsed <= max) return parsed;
    }
    return def;
}
