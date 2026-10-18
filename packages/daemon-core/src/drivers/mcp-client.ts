/** SDK-neutral Tools-only boundary. Other MCP features are not advertised. */
export interface DriverTool {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}
export interface DriverToolResult {
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}
/** Local invocation handle; the SDK owns the wire request id. */
export interface DriverCall extends Promise<DriverToolResult> { readonly id: string }
export interface DriverMcpClient {
    listTools(): Promise<DriverTool[]>;
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): DriverCall;
    cancel(id: string): void;
    close(): Promise<void>;
}
export class DriverMcpError extends Error {
    constructor(readonly code: 'cancelled' | 'timeout' | 'connection_closed' | 'protocol_error' | 'failed', message: string) {
        super(message);
        this.name = 'DriverMcpError';
    }
}
