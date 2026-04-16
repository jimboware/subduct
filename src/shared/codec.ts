import type { BodyEncoding, FormField, FormPayload, Headers } from './types.js';

export function base64EncodeBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(binary);
}

export function base64DecodeBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = globalThis.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function normalizeHeaders(input: Headers | undefined): Headers {
  const out: Headers = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) out[k.toLowerCase()] = v;
  return out;
}

export async function encodeBody(
  body: unknown,
): Promise<{ encoding: BodyEncoding; body: unknown; contentType: string | null }> {
  if (body === undefined || body === null) {
    return { encoding: 'none', body: null, contentType: null };
  }
  if (typeof body === 'string') {
    return { encoding: 'text', body, contentType: 'text/plain;charset=utf-8' };
  }
  if (typeof body === 'number' || typeof body === 'boolean') {
    return { encoding: 'json', body, contentType: 'application/json' };
  }
  if (body instanceof ArrayBuffer) {
    return {
      encoding: 'base64',
      body: base64EncodeBytes(new Uint8Array(body)),
      contentType: 'application/octet-stream',
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      encoding: 'base64',
      body: base64EncodeBytes(bytes),
      contentType: 'application/octet-stream',
    };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const buf = await body.arrayBuffer();
    const contentType = body.type || 'application/octet-stream';
    return {
      encoding: 'base64',
      body: base64EncodeBytes(new Uint8Array(buf)),
      contentType,
    };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      encoding: 'urlencoded',
      body: body.toString(),
      contentType: 'application/x-www-form-urlencoded;charset=utf-8',
    };
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields: Array<[string, FormField]> = [];
    for (const [key, value] of body.entries()) {
      if (typeof value === 'string') {
        fields.push([key, { kind: 'string', value }]);
      } else {
        const buf = await (value as Blob).arrayBuffer();
        fields.push([
          key,
          {
            kind: 'blob',
            name: (value as File).name ?? 'blob',
            type: (value as Blob).type || 'application/octet-stream',
            data: base64EncodeBytes(new Uint8Array(buf)),
          },
        ]);
      }
    }
    return {
      encoding: 'form',
      body: { fields } satisfies FormPayload,
      contentType: 'multipart/form-data',
    };
  }
  return { encoding: 'json', body, contentType: 'application/json' };
}

export function decodeBodyForServer(encoding: BodyEncoding, body: unknown): unknown {
  switch (encoding) {
    case 'none':
      return undefined;
    case 'json':
      return body;
    case 'text':
      return body;
    case 'base64':
      return typeof body === 'string' ? base64DecodeBytes(body) : undefined;
    case 'urlencoded':
      return typeof body === 'string' ? new URLSearchParams(body) : undefined;
    case 'form': {
      if (!body || typeof body !== 'object') return undefined;
      const payload = body as FormPayload;
      const out: Record<string, FormField | FormField[]> = {};
      for (const [key, field] of payload.fields) {
        const existing = out[key];
        if (existing === undefined) {
          out[key] = field;
        } else if (Array.isArray(existing)) {
          existing.push(field);
        } else {
          out[key] = [existing, field];
        }
      }
      return out;
    }
  }
}

export function decodeBodyForClient(
  encoding: BodyEncoding,
  body: unknown,
  responseType: 'json' | 'text' | 'blob' | 'arraybuffer' | 'auto',
): { data: unknown; raw: unknown } {
  switch (encoding) {
    case 'none':
      return { data: null, raw: null };
    case 'json': {
      if (responseType === 'text')
        return { data: typeof body === 'string' ? body : JSON.stringify(body), raw: body };
      return { data: body, raw: body };
    }
    case 'text': {
      const text = typeof body === 'string' ? body : String(body ?? '');
      if (responseType === 'json') {
        try {
          return { data: JSON.parse(text), raw: text };
        } catch {
          return { data: text, raw: text };
        }
      }
      return { data: text, raw: text };
    }
    case 'base64': {
      const bytes = typeof body === 'string' ? base64DecodeBytes(body) : new Uint8Array();
      if (responseType === 'text') {
        return { data: new TextDecoder().decode(bytes), raw: bytes };
      }
      if (responseType === 'blob') {
        if (typeof Blob !== 'undefined')
          return { data: new Blob([bytes.slice().buffer]), raw: bytes };
        return { data: bytes, raw: bytes };
      }
      if (responseType === 'arraybuffer') {
        return { data: bytes.slice().buffer, raw: bytes };
      }
      return { data: bytes, raw: bytes };
    }
    case 'urlencoded': {
      const text = typeof body === 'string' ? body : '';
      if (responseType === 'text') return { data: text, raw: text };
      return { data: new URLSearchParams(text), raw: text };
    }
    case 'form':
      return { data: body, raw: body };
  }
}

export function encodeResponseBody(body: unknown): {
  encoding: BodyEncoding;
  body: unknown;
  contentType: string | null;
} {
  if (body === undefined || body === null)
    return { encoding: 'none', body: null, contentType: null };
  if (typeof body === 'string')
    return { encoding: 'text', body, contentType: 'text/plain;charset=utf-8' };
  if (body instanceof ArrayBuffer) {
    return {
      encoding: 'base64',
      body: base64EncodeBytes(new Uint8Array(body)),
      contentType: 'application/octet-stream',
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      encoding: 'base64',
      body: base64EncodeBytes(bytes),
      contentType: 'application/octet-stream',
    };
  }
  return { encoding: 'json', body, contentType: 'application/json' };
}

export function statusText(code: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return map[code] ?? '';
}
