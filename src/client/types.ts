import type { BodyEncoding, Method } from '../shared/types.js';

export type ResponseType = 'auto' | 'json' | 'text' | 'blob' | 'arraybuffer';

export interface RequestConfig {
  method?: Method;
  url?: string;
  path?: string;
  signal?: string;
  headers?: Record<string, string>;
  body?: unknown;
  params?: Record<
    string,
    string | number | boolean | null | undefined | Array<string | number | boolean>
  >;
  responseType?: ResponseType;
  timeout?: number;
  abortSignal?: AbortSignal;
  iceServers?: RTCIceServer[];
}

export interface ClientResponseInit<T> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  raw: unknown;
  bodyEncoding: BodyEncoding;
}

export interface ClientResponse<T = unknown> {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Record<string, string>;
  readonly data: T;
  json<U = unknown>(): Promise<U>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SessionOptions {
  signal: string;
  iceServers?: RTCIceServer[];
  headers?: Record<string, string>;
  timeout?: number;
  token?: string;
  baseUrl?: string;
  chunkSize?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}
