import type { ProviderModule } from './contracts.js';
export declare function getApprovalPositiveHints(provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null): string[];
export declare function pickApprovalButton(buttons: string[] | null | undefined, provider?: Pick<ProviderModule, 'approvalPositiveHints'> | null): {
    index: number;
    label: string;
};
export declare function formatAutoApprovalMessage(modalMessage?: string, buttonLabel?: string): string;
