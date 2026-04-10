/**
 * CDP Commands — cdpEval, screenshot, cdpCommand, cdpBatch, cdpRemoteAction,
 *                discoverAgents, file operations
 */
import type { CommandResult, CommandHelpers } from './handler.js';
export declare function handleCdpEval(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleScreenshot(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleCdpCommand(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleCdpBatch(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleCdpRemoteAction(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleDiscoverAgents(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleFileRead(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleFileWrite(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleFileList(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleFileListBrowse(h: CommandHelpers, args: any): Promise<CommandResult>;
