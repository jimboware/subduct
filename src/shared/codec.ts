import { EMPTY_BYTES } from './protocol.js';
import type { BodyEncoding, FormField, FormPayload, Headers } from './types.js';

export interface EncodedBody {
  encoding: BodyEncoding;
  headerBody: unknown;
  bytes: Uint8Array;
  contentType: string | null;
}

function base64EncodeBytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(binary);
}

function base64DecodeBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = globalThis.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function viewToBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

export function normalizeHeaders(input: Headers | undefined): Headers {
  const out: Headers = {};
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) out[k.toLowerCase()] = v;
  return out;
}

export async function encodeBody(body: unknown): Promise<EncodedBody> {
  if (body === undefined || body === null) {
    return { encoding: 'none', headerBody: null, bytes: EMPTY_BYTES, contentType: null };
  }
  if (typeof body === 'string') {
    return {
      encoding: 'text',
      headerBody: body,
      bytes: EMPTY_BYTES,
      contentType: 'text/plain;charset=utf-8',
    };
  }
  if (typeof body === 'number' || typeof body === 'boolean') {
    return {
      encoding: 'json',
      headerBody: body,
      bytes: EMPTY_BYTES,
      contentType: 'application/json',
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: new Uint8Array(body),
      contentType: 'application/octet-stream',
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: viewToBytes(body),
      contentType: 'application/octet-stream',
    };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const buf = await body.arrayBuffer();
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: new Uint8Array(buf),
      contentType: body.type || 'application/octet-stream',
    };
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      encoding: 'urlencoded',
      headerBody: body.toString(),
      bytes: EMPTY_BYTES,
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
      headerBody: { fields } satisfies FormPayload,
      bytes: EMPTY_BYTES,
      contentType: 'multipart/form-data',
    };
  }
  return {
    encoding: 'json',
    headerBody: body,
    bytes: EMPTY_BYTES,
    contentType: 'application/json',
  };
}

export async function encodeResponseBody(body: unknown): Promise<EncodedBody> {
  if (body === undefined || body === null) {
    return { encoding: 'none', headerBody: null, bytes: EMPTY_BYTES, contentType: null };
  }
  if (typeof body === 'string') {
    return {
      encoding: 'text',
      headerBody: body,
      bytes: EMPTY_BYTES,
      contentType: 'text/plain;charset=utf-8',
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: new Uint8Array(body),
      contentType: 'application/octet-stream',
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: viewToBytes(body),
      contentType: 'application/octet-stream',
    };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    const buf = await body.arrayBuffer();
    return {
      encoding: 'raw',
      headerBody: null,
      bytes: new Uint8Array(buf),
      contentType: body.type || 'application/octet-stream',
    };
  }
  return {
    encoding: 'json',
    headerBody: body,
    bytes: EMPTY_BYTES,
    contentType: 'application/json',
  };
}

export function decodeBodyForServer(
  encoding: BodyEncoding,
  headerBody: unknown,
  bytes: Uint8Array,
): unknown {
  switch (encoding) {
    case 'none':
      return undefined;
    case 'json':
      return headerBody;
    case 'text':
      return headerBody;
    case 'raw':
      return bytes;
    case 'urlencoded':
      return typeof headerBody === 'string' ? new URLSearchParams(headerBody) : undefined;
    case 'form': {
      if (!headerBody || typeof headerBody !== 'object') return undefined;
      const payload = headerBody as FormPayload;
      const out: Record<string, FormField | FormField[]> = {};
      for (const [key, field] of payload.fields) {
        const resolved =
          field.kind === 'blob' ? { ...field, bytes: base64DecodeBytes(field.data) } : field;
        const existing = out[key];
        if (existing === undefined) {
          out[key] = resolved as FormField;
        } else if (Array.isArray(existing)) {
          existing.push(resolved as FormField);
        } else {
          out[key] = [existing, resolved as FormField];
        }
      }
      return out;
    }
  }
}

export function decodeBodyForClient(
  encoding: BodyEncoding,
  headerBody: unknown,
  bytes: Uint8Array,
  responseType: 'json' | 'text' | 'blob' | 'arraybuffer' | 'auto',
): { data: unknown; raw: unknown } {
  switch (encoding) {
    case 'none':
      return { data: null, raw: null };
    case 'json': {
      if (responseType === 'text') {
        return {
          data: typeof headerBody === 'string' ? headerBody : JSON.stringify(headerBody),
          raw: headerBody,
        };
      }
      return { data: headerBody, raw: headerBody };
    }
    case 'text': {
      const text = typeof headerBody === 'string' ? headerBody : String(headerBody ?? '');
      if (responseType === 'json') {
        try {
          return { data: JSON.parse(text), raw: text };
        } catch {
          return { data: text, raw: text };
        }
      }
      return { data: text, raw: text };
    }
    case 'raw': {
      if (responseType === 'text') {
        return { data: new TextDecoder().decode(bytes), raw: bytes };
      }
      if (responseType === 'json') {
        try {
          return { data: JSON.parse(new TextDecoder().decode(bytes)), raw: bytes };
        } catch {
          return { data: bytes, raw: bytes };
        }
      }
      if (responseType === 'blob' && typeof Blob !== 'undefined') {
        return { data: new Blob([bytes.slice()]), raw: bytes };
      }
      if (responseType === 'arraybuffer') {
        return { data: bytes.slice().buffer, raw: bytes };
      }
      return { data: bytes, raw: bytes };
    }
    case 'urlencoded': {
      const text = typeof headerBody === 'string' ? headerBody : '';
      if (responseType === 'text') return { data: text, raw: text };
      return { data: new URLSearchParams(text), raw: text };
    }
    case 'form':
      return { data: headerBody, raw: headerBody };
  }
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
