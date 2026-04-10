/**
 * CDP DOM Analysis Tools — DOM dump, query, debug
 *
 * Separated from daemon-commands.ts.
 * Tools for analyzing DOM structure when developing new IDE scripts.
 */
import type { DaemonCdpManager } from './manager.js';
import type { CommandResult } from '../commands/handler.js';
type CdpGetter = (ideType?: string) => DaemonCdpManager | null;
/**
 * CDP DOM analysis handler
 *
 * Uses getCdp from DaemonCommandHandler.
 */
export declare class CdpDomHandlers {
    private getCdp;
    constructor(getCdp: CdpGetter);
    /**
    * CDP DOM Dump — IDE's DOM tree retrieve
    *
    * args:
    * selector?: string — CSS selector to dump specific area only (default: All)
    * depth?: number — Dump depth limit (default: 10)
    * attrs?: boolean — Whether to include properties (default: true)
    * maxLength?: number — Max character count (default: 200000)
    * format?: 'html' | 'tree' | 'summary' — Output format (default: 'html')
    * sessionId?: string — Agent webview session ID (if provided, match webview DOM)
    */
    handleDomDump(args: any): Promise<CommandResult>;
    /**
    * CDP DOM Query — CSS Test selector
    * Check how many elements match selector and what elements they are
    *
    * args:
    * selector: string — CSS selector
    * limit?: number — Max element count to return (default: 20)
    * content?: boolean — Whether to include text content (default: true)
    * sessionId?: string — agent webview session ID
    */
    handleDomQuery(args: any): Promise<CommandResult>;
    /**
    * CDP DOM Debug — IDE AI panel specialized analysis
    * Collect all essential info at once when supporting new IDE
    *
    * args:
    * ideType?: string — IDE type hint
    * sessionId?: string — agent webview session ID
    */
    handleDomDebug(args: any): Promise<CommandResult>;
}
export {};
