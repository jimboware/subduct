import { decodeBodyForClient, encodeBody } from '../shared/codec.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, randomId } from '../shared/protocol.js';
import type { Method, RequestMessage } from '../shared/types.js';
import { Connection } from './connection.js';
import { SubductClientResponse } from './response.js';
import type { ClientResponse, RequestConfig, ResponseType, SessionOptions } from './types.js';
import { mergeQuery, resolveUrl } from './url.js';

export class Session {
  private readonly opts: SessionOptions;
  private connection: Connection | null = null;

  constructor(opts: SessionOptions) {
    this.opts = opts;
  }

  get signalUrl(): string {
    return this.opts.signal;
  }

  get isOpen(): boolean {
    return this.connection?.isOpen() ?? false;
  }

  async connect(): Promise<void> {
    const conn = this.ensureConnection();
    await conn.open();
  }

  private ensureConnection(): Connection {
    if (this.connection && this.connection.getState() !== 'closed') return this.connection;
    this.connection = new Connection({
      signal: this.opts.signal,
      iceServers: this.opts.iceServers,
      token: this.opts.token,
      chunkSize: this.opts.chunkSize,
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.opts.heartbeatTimeoutMs,
    });
    return this.connection;
  }

  request<T = unknown>(config: RequestConfig): Promise<ClientResponse<T>> {
    return executeRequest<T>(
      this.ensureConnection(),
      {
        ...config,
        signal: config.signal ?? this.opts.signal,
        headers: { ...this.opts.headers, ...config.headers },
        timeout: config.timeout ?? this.opts.timeout,
      },
      this.opts.baseUrl,
    );
  }

  get<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'GET', url });
  }
  post<T = unknown>(
    url: string,
    body?: unknown,
    config?: RequestConfig,
  ): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'POST', url, body });
  }
  put<T = unknown>(
    url: string,
    body?: unknown,
    config?: RequestConfig,
  ): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'PUT', url, body });
  }
  patch<T = unknown>(
    url: string,
    body?: unknown,
    config?: RequestConfig,
  ): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'PATCH', url, body });
  }
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'DELETE', url });
  }
  head<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'HEAD', url });
  }
  options<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
    return this.request<T>({ ...config, method: 'OPTIONS', url });
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
  }
}

export function createClient(opts: SessionOptions): Session {
  return new Session(opts);
}

export async function executeRequest<T = unknown>(
  connection: Connection,
  config: RequestConfig,
  baseUrl: string | undefined,
): Promise<ClientResponse<T>> {
  const method = (config.method ?? 'GET') as Method;
  const resolved = resolveUrl(config.url, config.signal, config.path, baseUrl);
  const query = mergeQuery(resolved.query, config.params);
  const { encoding, body, contentType } = await encodeBody(config.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) headers[k.toLowerCase()] = v;
  if (contentType && !headers['content-type']) headers['content-type'] = contentType;

  const message: RequestMessage = {
    kind: 'request',
    id: randomId(),
    method,
    path: resolved.path,
    query,
    headers,
    bodyEncoding: encoding,
    body,
  };

  const response = await connection.request(
    message,
    config.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    config.abortSignal,
  );

  const responseType: ResponseType = config.responseType ?? 'auto';
  const { data, raw } = decodeBodyForClient(response.bodyEncoding, response.body, responseType);

  return new SubductClientResponse<T>({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data: data as T,
    raw,
    bodyEncoding: response.bodyEncoding,
  });
}
