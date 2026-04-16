import type { BodyEncoding } from '../shared/types.js';
import type { ClientResponse, ClientResponseInit } from './types.js';

export class SubductClientResponse<T = unknown> implements ClientResponse<T> {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly data: T;
  private readonly raw: unknown;
  private readonly bodyEncoding: BodyEncoding;

  constructor(init: ClientResponseInit<T>) {
    this.status = init.status;
    this.statusText = init.statusText;
    this.headers = init.headers;
    this.data = init.data;
    this.raw = init.raw;
    this.bodyEncoding = init.bodyEncoding;
    this.ok = init.status >= 200 && init.status < 300;
  }

  async json<U = unknown>(): Promise<U> {
    if (this.bodyEncoding === 'json') return this.data as unknown as U;
    if (typeof this.raw === 'string') return JSON.parse(this.raw) as U;
    if (this.raw instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(this.raw)) as U;
    }
    return this.data as unknown as U;
  }

  async text(): Promise<string> {
    if (typeof this.raw === 'string') return this.raw;
    if (this.raw instanceof Uint8Array) return new TextDecoder().decode(this.raw);
    if (this.raw === null || this.raw === undefined) return '';
    if (typeof this.raw === 'object') return JSON.stringify(this.raw);
    return String(this.raw);
  }

  async blob(): Promise<Blob> {
    const bytes = this.toBytes();
    return new Blob([bytes.slice()], {
      type: this.headers['content-type'] ?? 'application/octet-stream',
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.toBytes().slice().buffer;
  }

  private toBytes(): Uint8Array {
    if (this.raw instanceof Uint8Array) return this.raw;
    if (typeof this.raw === 'string') return new TextEncoder().encode(this.raw);
    if (this.raw && typeof this.raw === 'object') {
      return new TextEncoder().encode(JSON.stringify(this.raw));
    }
    return new Uint8Array();
  }
}
