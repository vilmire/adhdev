import type { ProviderModule } from './contracts.js';
export declare function isUnsafeApprovalButtonLabel(value: string): boolean;
export declare function getApprovalPositiveHints(provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null): string[];
export declare function pickApprovalButton(buttons: string[] | null | undefined, provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null): {
    index: number;
    label: string;
    unsafe?: boolean;
};
export declare function formatAutoApprovalMessage(modalMessage?: string, buttonLabel?: string): string;
