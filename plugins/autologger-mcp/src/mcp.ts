// A minimal MCP client over Streamable HTTP: JSON-RPC 2.0 POSTs to the MCP endpoint with the
// bearer token, `initialize` then `notifications/initialized`, then `tools/list` / `tools/call`.
// Answers may be `application/json` or a `text/event-stream`. A 401 refreshes the token once.
import type { TokenSource } from './auth.ts';
import { notSignedIn } from './auth.ts';
import { CliError } from './errors.ts';
import { clip, type Fetch, isObject, request } from './http.ts';

export const PROTOCOL_VERSION = '2025-11-25';
const KNOWN_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_TOOL_PAGES = 50;

export interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface CallToolResult {
  content?: { type: string; text?: string; [key: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** A JSON-RPC error answer, or a tool result with `isError`. */
export class McpError extends CliError {}

interface JsonRpcAnswer {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** The JSON-RPC message with `id` from an SSE body. */
export function messageFromEventStream(text: string, id: number): JsonRpcAnswer | undefined {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data === '') continue;
    try {
      const message: unknown = JSON.parse(data);
      if (isObject(message) && message.id === id) return message as JsonRpcAnswer;
    } catch {
      // not JSON: skip
    }
  }
  return undefined;
}

export class McpClient {
  private readonly endpoint: string;
  private readonly tokens: TokenSource;
  private readonly fetchFn: Fetch;
  private readonly clientVersion: string;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  private refreshed = false;

  constructor(opts: { endpoint: string; tokens: TokenSource; fetch: Fetch; clientVersion: string }) {
    this.endpoint = opts.endpoint;
    this.tokens = opts.tokens;
    this.fetchFn = opts.fetch;
    this.clientVersion = opts.clientVersion;
  }

  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'autologger-mcp', version: this.clientVersion },
    });
    const version = isObject(result) ? result.protocolVersion : undefined;
    if (typeof version !== 'string' || !KNOWN_VERSIONS.includes(version)) {
      throw new McpError(`the MCP server answered protocol version '${clip(version)}', which this CLI does not speak`);
    }
    this.protocolVersion = version;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined);
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!isObject(result) || !Array.isArray(result.tools)) throw new McpError('tools/list answered no tools');
      for (const tool of result.tools) if (isObject(tool) && typeof tool.name === 'string') tools.push(tool as Tool);
      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') return tools;
      cursor = result.nextCursor;
    }
    throw new McpError(`tools/list did not end after ${MAX_TOOL_PAGES} pages`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    if (!isObject(result)) throw new McpError('tools/call answered no result');
    return result as CallToolResult;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const answer = await this.post({ jsonrpc: '2.0', id, method, params }, id);
    if (answer === undefined) throw new McpError(`${method}: the MCP server sent no answer`);
    if (answer.error !== undefined) {
      const { code, message } = answer.error;
      throw new McpError(`${method} failed: ${clip(message ?? 'unknown error')}${typeof code === 'number' ? ` (JSON-RPC ${code})` : ''}`);
    }
    return answer.result;
  }

  private async post(body: unknown, id: number | undefined): Promise<JsonRpcAnswer | undefined> {
    let token = await this.tokens.token();
    for (;;) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      };
      if (this.protocolVersion !== undefined) headers['mcp-protocol-version'] = this.protocolVersion;
      if (this.sessionId !== undefined) headers['mcp-session-id'] = this.sessionId;
      const response = await request(this.fetchFn, this.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
      if (response.status === 401) {
        await response.body?.cancel();
        if (this.refreshed) throw notSignedIn(this.tokens.ctx.store, 'the server rejected the access token even after a refresh', this.tokens.ctx.now());
        this.refreshed = true;
        token = await this.tokens.afterRejection(token);
        continue;
      }
      const session = response.headers.get('mcp-session-id');
      if (session !== null && session !== '') this.sessionId = session;
      if (response.status === 202) {
        await response.body?.cancel();
        return undefined;
      }
      const text = await response.text();
      const type = response.headers.get('content-type') ?? '';
      let answer: JsonRpcAnswer | undefined;
      if (type.includes('text/event-stream') && id !== undefined) {
        answer = messageFromEventStream(text, id);
      } else {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isObject(parsed)) answer = parsed as JsonRpcAnswer;
        } catch {
          answer = undefined;
        }
      }
      if (response.ok) {
        if (id === undefined) return undefined;
        return answer;
      }
      if (answer?.error !== undefined) return answer;
      const detail = isObject(answer) && typeof (answer as Record<string, unknown>).detail === 'string'
        ? (answer as Record<string, unknown>).detail
        : text;
      throw new McpError(`POST ${new URL(this.endpoint).pathname} answered ${response.status}${detail ? `: ${clip(detail)}` : ''}`);
    }
  }
}

/** The text a tool result shows a reader: its text content, else its structured content. */
export function resultText(result: CallToolResult): string {
  const texts = (result.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  if (texts.length > 0) return texts.join('\n');
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent, null, 2);
  return JSON.stringify(result.content ?? [], null, 2);
}
