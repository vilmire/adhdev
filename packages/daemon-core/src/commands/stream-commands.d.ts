/**
 * Stream Commands — Agent Stream, PTY I/O, Provider Settings,
 *                   IDE Extension Settings, Extension Script Execution
 */
import type { CommandResult, CommandHelpers } from './handler.js';
export declare function handleFocusSession(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handlePtyInput(h: CommandHelpers, args: any): CommandResult;
export declare function handlePtyResize(h: CommandHelpers, args: any): CommandResult;
export declare function handleGetProviderSettings(h: CommandHelpers, args: any): CommandResult;
export declare function handleSetProviderSetting(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleExtensionScript(h: CommandHelpers, args: any, scriptName: string): Promise<CommandResult>;
export declare function handleProviderScript(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleGetIdeExtensions(h: CommandHelpers, args: any): CommandResult;
export declare function handleSetIdeExtension(h: CommandHelpers, args: any): CommandResult;
