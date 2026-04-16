import type { BodyEncoding, Headers, Method } from '../shared/types.js';
import { decodeBodyForServer, normalizeHeaders } from '../shared/codec.js';

export interface ServerRequestInit {
  id: string;
  method: Method;
  path: string;
  query: Record<string, string | string[]>;
  headers: Headers;
  bodyEncoding: BodyEncoding;
  body: unknown;
  sessionId: string;
  remoteAddress?: string | undefined;
  signal: AbortSignal;
}

export class ServerRequest {
  readonly id: string;
  readonly method: Method;
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  readonly headers: Headers;
  readonly sessionId: string;
  readonly remoteAddress?: string;
  readonly bodyEncoding: BodyEncoding;
  readonly signal: AbortSignal;
  body: unknown;
  params: Record<string, string> = {};
  locals: Record<string, unknown> = {};

  constructor(init: ServerRequestInit) {
    this.id = init.id;
    this.method = init.method;
    this.path = init.path;
    this.query = init.query;
    this.headers = normalizeHeaders(init.headers);
    this.sessionId = init.sessionId;
    this.remoteAddress = init.remoteAddress;
    this.bodyEncoding = init.bodyEncoding;
    this.signal = init.signal;
    this.body = decodeBodyForServer(init.bodyEncoding, init.body);
  }

  get(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  header(name: string): string | undefined {
    return this.get(name);
  }
}
