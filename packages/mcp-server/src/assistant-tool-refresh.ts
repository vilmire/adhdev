import type { CommandTransport } from './transports/mode.js';
import { availableAssistantTools, type AssistantModeTool } from './tools/assistant-tools.js';

/** Refresh from the live daemon, including attestation after the MCP process starts. */
export class AssistantToolRefresh {
  private signature: string | null = null;
  private running = false;
  constructor(private transport: Pick<CommandTransport, 'command'>, private sessionId: string | undefined,
    private tools: readonly AssistantModeTool[], private notify: () => Promise<void>) {}
  recordListed(list: readonly AssistantModeTool[]): void { this.signature = list.map(t => t.name).join(','); }
  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const signature = (await availableAssistantTools(this.transport, this.sessionId, this.tools)).map(t => t.name).join(',');
      if (this.signature !== null && this.signature !== signature) await this.notify();
      this.signature = signature;
    } finally { this.running = false; }
  }
}
