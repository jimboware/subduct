import type { Headers, ResponseMessage } from '../shared/types.js';
import { encodeResponseBody, statusText as defaultStatusText } from '../shared/codec.js';

type SendFn = (msg: ResponseMessage) => void;

export class ServerResponse {
  private _status = 200;
  private _statusText: string | null = null;
  private _headers: Headers = {};
  private _ended = false;
  private readonly requestId: string;
  private readonly send_: SendFn;

  constructor(requestId: string, send: SendFn) {
    this.requestId = requestId;
    this.send_ = send;
  }

  get ended(): boolean {
    return this._ended;
  }

  status(code: number): this {
    this._status = code;
    return this;
  }

  statusText(text: string): this {
    this._statusText = text;
    return this;
  }

  set(name: string, value: string): this;
  set(headers: Headers): this;
  set(nameOrHeaders: string | Headers, value?: string): this {
    if (typeof nameOrHeaders === 'string') {
      if (value !== undefined) this._headers[nameOrHeaders.toLowerCase()] = value;
    } else {
      for (const [k, v] of Object.entries(nameOrHeaders)) this._headers[k.toLowerCase()] = v;
    }
    return this;
  }

  header(name: string, value: string): this {
    return this.set(name, value);
  }

  get(name: string): string | undefined {
    return this._headers[name.toLowerCase()];
  }

  type(contentType: string): this {
    this._headers['content-type'] = contentType;
    return this;
  }

  json(data: unknown): this {
    if (this._ended) return this;
    if (!this._headers['content-type']) this._headers['content-type'] = 'application/json';
    this.finalize({ encoding: 'json', body: data });
    return this;
  }

  send(data?: unknown): this {
    if (this._ended) return this;
    if (data === undefined || data === null) {
      this.finalize({ encoding: 'none', body: null });
      return this;
    }
    const encoded = encodeResponseBody(data);
    if (!this._headers['content-type'] && encoded.contentType) {
      this._headers['content-type'] = encoded.contentType;
    }
    this.finalize({ encoding: encoded.encoding, body: encoded.body });
    return this;
  }

  end(data?: unknown): void {
    if (data !== undefined) this.send(data);
    else if (!this._ended) this.finalize({ encoding: 'none', body: null });
  }

  sendStatus(code: number): this {
    this.status(code).send(defaultStatusText(code) || String(code));
    return this;
  }

  private finalize(payload: { encoding: ResponseMessage['bodyEncoding']; body: unknown }): void {
    if (this._ended) return;
    this._ended = true;
    const msg: ResponseMessage = {
      kind: 'response',
      id: this.requestId,
      status: this._status,
      statusText: this._statusText ?? defaultStatusText(this._status),
      headers: this._headers,
      bodyEncoding: payload.encoding,
      body: payload.body,
    };
    this.send_(msg);
  }

  failWith(code: number, message: string): void {
    if (this._ended) return;
    this.status(code).json({ error: message });
  }
}
