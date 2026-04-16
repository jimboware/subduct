import type { ChunkFrame, Frame, FrameKind } from './types.js';

export const PROTOCOL_VERSION = 2;
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
export const DEFAULT_BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024;
export const DEFAULT_BUFFERED_AMOUNT_LOW = 256 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120000;
export const DEFAULT_REASSEMBLY_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_REASSEMBLY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_MESSAGES = 64;
export const DEFAULT_SIGNAL_PATH = '/subduct';
export const DEFAULT_MAX_SIGNAL_PAYLOAD = 64 * 1024;

export const EMPTY_BYTES = new Uint8Array(0);

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const VALID_FRAME_KINDS: ReadonlySet<FrameKind> = new Set<FrameKind>([
  'request',
  'response',
  'error',
  'cancel',
  'ping',
  'pong',
  'chunk',
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function randomId(): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export interface DecodedEnvelope {
  header: Frame;
  body: Uint8Array;
}

export function encodeEnvelope(header: Frame, body: Uint8Array): Uint8Array {
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + body.length);
  const view = new DataView(out.buffer, out.byteOffset, 4);
  view.setUint32(0, headerBytes.length, false);
  out.set(headerBytes, 4);
  if (body.length > 0) out.set(body, 4 + headerBytes.length);
  return out;
}

export function decodeEnvelope(bytes: Uint8Array): DecodedEnvelope | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen > bytes.length - 4) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!isValidFrame(parsed)) return null;
  return { header: parsed as Frame, body: bytes.subarray(4 + headerLen) };
}

function isValidFrame(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== 'string' || !VALID_FRAME_KINDS.has(kind as FrameKind)) return false;
  switch (kind) {
    case 'request':
      return (
        typeof o.id === 'string' &&
        typeof o.method === 'string' &&
        typeof o.path === 'string' &&
        typeof o.bodyEncoding === 'string'
      );
    case 'response':
      return (
        typeof o.id === 'string' &&
        typeof o.status === 'number' &&
        typeof o.bodyEncoding === 'string'
      );
    case 'error':
      return (
        typeof o.id === 'string' && typeof o.code === 'string' && typeof o.message === 'string'
      );
    case 'cancel':
      return typeof o.id === 'string';
    case 'ping':
    case 'pong':
      return typeof o.ts === 'number';
    case 'chunk':
      return typeof o.cid === 'string' && typeof o.seq === 'number' && typeof o.total === 'number';
    default:
      return false;
  }
}

export function serializeFrame(
  header: Frame,
  body: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Uint8Array[] {
  const envelope = encodeEnvelope(header, body);
  if (envelope.length <= chunkSize) return [envelope];
  const cid = randomId();
  const slices: Uint8Array[] = [];
  for (let i = 0; i < envelope.length; i += chunkSize) {
    slices.push(envelope.subarray(i, Math.min(i + chunkSize, envelope.length)));
  }
  return slices.map((slice, seq) =>
    encodeEnvelope({ kind: 'chunk', cid, seq, total: slices.length } satisfies ChunkFrame, slice),
  );
}

interface PendingEntry {
  parts: Array<Uint8Array | undefined>;
  received: number;
  total: number;
  bytes: number;
  deadline: number;
}

export interface FrameAssemblerOptions {
  maxPending?: number;
  maxBytes?: number;
  reassemblyTimeoutMs?: number;
}

export class FrameAssembler {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly maxPending: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;

  constructor(opts: FrameAssemblerOptions = {}) {
    this.maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING_MESSAGES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_REASSEMBLY_BYTES;
    this.timeoutMs = opts.reassemblyTimeoutMs ?? DEFAULT_REASSEMBLY_TIMEOUT_MS;
  }

  ingest(bytes: Uint8Array): DecodedEnvelope | null {
    const envelope = decodeEnvelope(bytes);
    if (!envelope) return null;
    if (envelope.header.kind !== 'chunk') return envelope;
    const frame = envelope.header;
    if (
      typeof frame.cid !== 'string' ||
      typeof frame.seq !== 'number' ||
      typeof frame.total !== 'number' ||
      frame.total <= 0 ||
      frame.seq < 0 ||
      frame.seq >= frame.total
    ) {
      return null;
    }
    this.sweep();
    let entry = this.pending.get(frame.cid);
    if (!entry) {
      if (this.pending.size >= this.maxPending) return null;
      entry = {
        parts: Array.from<Uint8Array | undefined>({ length: frame.total }),
        received: 0,
        total: frame.total,
        bytes: 0,
        deadline: Date.now() + this.timeoutMs,
      };
      this.pending.set(frame.cid, entry);
    }
    if (entry.total !== frame.total) return null;
    if (entry.parts[frame.seq] !== undefined) return null;
    if (entry.bytes + envelope.body.length > this.maxBytes) {
      this.pending.delete(frame.cid);
      return null;
    }
    entry.parts[frame.seq] = envelope.body;
    entry.received += 1;
    entry.bytes += envelope.body.length;
    entry.deadline = Date.now() + this.timeoutMs;
    if (entry.received !== entry.total) return null;
    this.pending.delete(frame.cid);
    const merged = new Uint8Array(entry.bytes);
    let offset = 0;
    for (const part of entry.parts) {
      if (!part) return null;
      merged.set(part, offset);
      offset += part.length;
    }
    const inner = decodeEnvelope(merged);
    if (!inner || inner.header.kind === 'chunk') return null;
    return inner;
  }

  private sweep(): void {
    if (this.pending.size === 0) return;
    const now = Date.now();
    for (const [cid, entry] of this.pending) {
      if (entry.deadline <= now) this.pending.delete(cid);
    }
  }

  clear(): void {
    this.pending.clear();
  }
}
