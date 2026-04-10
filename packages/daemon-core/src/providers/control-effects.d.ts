import type { ProviderControlDef, ProviderEffect } from './contracts.js';
export type ProviderControlValue = string | number | boolean;
export declare function extractProviderControlValues(controls: ProviderControlDef[] | undefined, data: any): Record<string, ProviderControlValue> | undefined;
export declare function normalizeProviderEffects(data: any): ProviderEffect[];
