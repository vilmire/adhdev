/**
 * CliAdapter — common interface for CLI agents
 *
 * Contract implemented by all CLI adapters (ProviderCliAdapter etc).
 */

export interface CliAdapter {
    cliType: string;
    cliName: string;
    workingDir: string;
    spawn(): Promise<void>;
    sendMessage(text: string): Promise<void>;
    getStatus(): any;
    getPartialResponse(): string;
    saveAndStop?(): Promise<void>;
    shutdown(): void;
    detach?(): void;
    cancel(): void;
    isProcessing(): boolean;
    isReady(): boolean;
    setOnStatusChange(callback: () => void): void;
    setServerConn?(serverConn: any): void;
 // Raw PTY I/O (for terminal view)
    setOnPtyData?(callback: (data: string) => void): void;
    writeRaw?(data: string): void;
    resize?(cols: number, rows: number): void;
}
