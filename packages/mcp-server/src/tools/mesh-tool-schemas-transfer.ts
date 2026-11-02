// Project file transfer for the coordinator (owner decision 2026-11-02, docs/design/2026-11-02-file-transfer-relay-option.md §6/§7).

export const MESH_FILE_TRANSFER_TOOL = {
    name: 'mesh_file_transfer',
    description: 'Request that project files move from THIS machine (or, with from_node_id/from_daemon_id, another machine of the mesh) to another machine of the same account, or check/cancel your own requests. '
        + 'action "request" builds a preview (file count, size, excluded secrets, and for target_mode "existing_path" which files are new vs replaced) and puts an approval into the owner\'s To-do; '
        + 'YOU CANNOT APPROVE - the owner approves in the dashboard, or (only if the owner enabled "auto-approve agent transfers" on BOTH machines and nothing would be replaced) the daemons approve it themselves. '
        + 'Secrets (.env, keys, .git) are never sent. Default target_mode "new_folder" writes a NEW folder named final_name and never replaces anything; "existing_path" writes into an existing directory of the target project and ALWAYS needs the owner (originals are backed up for 7 days and can be reverted). '
        + 'action "status" (with transfer_id, or omit it to list your requests) reports state/progress; "cancel" cancels your own request. Source files must be in a workspace of your mesh on the source machine; '
        + 'name the destination with to_node_id (a node of this mesh) or to_daemon_id + to_workspace.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: { type: 'string', enum: ['request', 'status', 'cancel'], description: 'Default status.' },
            from_workspace: { type: 'string', description: 'request: workspace of your mesh on the source machine (id or label) holding the files.' },
            selected: { type: 'array', items: { type: 'string' }, description: 'request: files/folders to send, relative to from_workspace (max 1000 entries).' },
            from_node_id: { type: 'string', description: 'request: source node of this mesh (its machine and workspace); default = this machine.' },
            from_daemon_id: { type: 'string', description: 'request: source machine id (instead of from_node_id); status/cancel of a remote request route automatically.' },
            to_node_id: { type: 'string', description: 'request: destination node of this mesh (its machine and workspace).' },
            to_daemon_id: { type: 'string', description: 'request: destination machine id (instead of to_node_id).' },
            to_workspace: { type: 'string', description: 'request: workspace on the destination machine (id, label or path); with to_node_id it defaults to the node workspace.' },
            target_mode: { type: 'string', enum: ['new_folder', 'existing_path'], description: 'Default new_folder.' },
            final_name: { type: 'string', description: 'new_folder: single-segment name of the new folder.' },
            target_dir: { type: 'string', description: 'existing_path: directory of the target project to write into (relative, empty = project root).' },
            transfer_id: { type: 'string', description: 'status/cancel: the request id.' },
        },
        required: [],
    },
};
