/**
 * Chat Commands — readChat, sendChat, listChats, newChat, switchChat,
 *                 setMode, changeModel, setThoughtLevel, resolveAction, chatHistory
 */
import type { CommandResult, CommandHelpers } from './handler.js';
export declare function handleChatHistory(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleReadChat(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleSendChat(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleListChats(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleNewChat(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleSwitchChat(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleSetMode(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleChangeModel(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleSetThoughtLevel(h: CommandHelpers, args: any): Promise<CommandResult>;
export declare function handleResolveAction(h: CommandHelpers, args: any): Promise<CommandResult>;
