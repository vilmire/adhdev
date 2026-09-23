/**
 * Normalize a standalone command envelope (`/api/v1/command` body or a WS
 * `command` frame) into `{ type, payload }`.
 *
 * Moved out of index.ts (wiring-unification B5). The `sessionId` →
 * `targetSessionId` alias that used to live here behind the standalone-only
 * `SESSION_TARGET_COMMANDS` table is gone: the router applies it for every
 * source from the command spec (`session.aliasSessionId`), so standalone and
 * cloud can no longer disagree about which commands get it.
 */

export function normalizeCommandEnvelope(input: Record<string, any> | null | undefined): { type: string; payload: Record<string, any> } {
  const body = input && typeof input === 'object' ? input : {};
  const type = typeof body.type === 'string' && body.type.trim()
    ? body.type.trim()
    : typeof body.commandType === 'string' && body.commandType.trim()
      ? body.commandType.trim()
      : typeof body.command === 'string' && body.command.trim()
        ? body.command.trim()
        : '';

  const payloadSource =
    body.payload && typeof body.payload === 'object'
      ? body.payload
      : body.args && typeof body.args === 'object'
        ? body.args
        : body.data && typeof body.data === 'object'
          ? body.data
          : null;

  const payload = payloadSource
    ? { ...payloadSource }
    : Object.fromEntries(
        Object.entries(body).filter(([key]) => (
          key !== 'type'
          && key !== 'commandType'
          && key !== 'command'
          && key !== 'payload'
          && key !== 'args'
          && key !== 'requestId'
          && key !== 'id'
        )),
      );

  return { type, payload };
}
