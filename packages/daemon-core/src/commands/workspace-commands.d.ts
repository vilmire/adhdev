/**
 * workspace_* commands — list/add/remove/default (config.json)
 */
export type WorkspaceCommandResult = {
    success: boolean;
    [key: string]: unknown;
};
export declare function handleWorkspaceList(): WorkspaceCommandResult;
export declare function handleWorkspaceAdd(args: any): WorkspaceCommandResult;
export declare function handleWorkspaceRemove(args: any): WorkspaceCommandResult;
export declare function handleWorkspaceSetDefault(args: any): WorkspaceCommandResult;
