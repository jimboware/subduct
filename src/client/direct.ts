import { Connection } from './connection.js';
import { executeRequest } from './session.js';
import type { ClientResponse, RequestConfig } from './types.js';
import { resolveUrl } from './url.js';

async function oneShot<T>(config: RequestConfig): Promise<ClientResponse<T>> {
  const resolved = resolveUrl(config.url, config.signal, config.path);
  const connection = new Connection({
    signal: resolved.signal,
    iceServers: config.iceServers,
  });
  try {
    return await executeRequest<T>(
      connection,
      { ...config, signal: resolved.signal, url: config.url },
      undefined,
    );
  } finally {
    connection.close();
  }
}

export function request<T = unknown>(config: RequestConfig): Promise<ClientResponse<T>> {
  return oneShot<T>(config);
}

export function get<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'GET', url });
}

export function post<T = unknown>(
  url: string,
  body?: unknown,
  config?: RequestConfig,
): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'POST', url, body });
}

export function put<T = unknown>(
  url: string,
  body?: unknown,
  config?: RequestConfig,
): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'PUT', url, body });
}

export function patch<T = unknown>(
  url: string,
  body?: unknown,
  config?: RequestConfig,
): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'PATCH', url, body });
}

export function del<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'DELETE', url });
}

export function head<T = unknown>(url: string, config?: RequestConfig): Promise<ClientResponse<T>> {
  return oneShot<T>({ ...config, method: 'HEAD', url });
}
