import { encodeResponseBody, statusText as defaultStatusText } from '../shared/codec.js';
import { EMPTY_BYTES } from '../shared/protocol.js';
import type { BodyEncoding, Headers, ResponseMessage } from '../shared/types.js';

type SendFn = (msg: ResponseMessage, body: Uint8Array) => void;

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
    this.finalize('json', data, EMPTY_BYTES);
    return this;
  }

  send(data?: unknown): this {
    if (this._ended) return this;
    if (data === undefined || data === null) {
      this.finalize('none', null, EMPTY_BYTES);
      return this;
    }
    this._ended = true;
    void encodeResponseBody(data).then(
      (encoded) => {
        if (encoded.contentType && !this._headers['content-type']) {
          this._headers['content-type'] = encoded.contentType;
        }
        this.emit(encoded.encoding, encoded.headerBody, encoded.bytes);
      },
      (err: unknown) => {
        this.emit('json', { error: String((err as Error)?.message ?? err) }, EMPTY_BYTES);
      },
    );
    return this;
  }

  end(data?: unknown): void {
    if (data !== undefined) this.send(data);
    else if (!this._ended) this.finalize('none', null, EMPTY_BYTES);
  }

  sendStatus(code: number): this {
    this.status(code).send(defaultStatusText(code) || String(code));
    return this;
  }

  private finalize(encoding: BodyEncoding, headerBody: unknown, bytes: Uint8Array): void {
    if (this._ended) return;
    this._ended = true;
    this.emit(encoding, headerBody, bytes);
  }

  private emit(encoding: BodyEncoding, headerBody: unknown, bytes: Uint8Array): void {
    const msg: ResponseMessage = {
      kind: 'response',
      id: this.requestId,
      status: this._status,
      statusText: this._statusText ?? defaultStatusText(this._status),
      headers: this._headers,
      bodyEncoding: encoding,
      body: headerBody,
    };
    this.send_(msg, bytes);
  }
}
