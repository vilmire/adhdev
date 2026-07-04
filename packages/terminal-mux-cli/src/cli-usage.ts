export function usage(exitCode = 1): never {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('adhmux — power-user terminal mux for self-hosted ADHDev runtimes\n\n');
  stream.write('Use this when you explicitly want local pane/workspace control around already-live hosted runtimes.\n');
  stream.write('For ordinary runtime supervision, recovery, and direct attach flows, start with `adhdev runtime ...`.\n\n');
  stream.write('Usage:\n');
  stream.write('  adhmux <command> [options] [runtimeKey...]\n\n');
  stream.write('Core commands:\n');
  stream.write('  list               List raw session-host records visible to adhmux\n');
  stream.write('  open <runtimeKey>  Open a mux workspace for a live runtime\n');
  stream.write('  snapshot <id>      Print the latest terminal snapshot for a runtime\n');
  stream.write('  sessions           List saved mux sessions\n');
  stream.write('  workspaces         List saved mux workspaces\n');
  stream.write('  attach-session     Reattach a previously saved mux workspace/session\n\n');
  stream.write('Notes:\n');
  stream.write('  - `open` only accepts live runtimes. Recover or restart snapshots first.\n');
  stream.write('  - `adhmux` is an expert/self-hosted surface, not the primary cloud runtime workflow.\n');
  stream.write('  - Run `adhdev runtime --help` for the main user-facing runtime commands.\n');
  process.exit(exitCode);
}
