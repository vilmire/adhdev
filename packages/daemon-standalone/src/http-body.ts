import type { IncomingMessage, ServerResponse } from 'http';

/** Maximum accepted JSON request body, in characters. */
const MAX_JSON_BODY_CHARS = 64 * 1024;

/** Read a size-capped JSON object body; an empty body yields `{}`. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_CHARS) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

export function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
