import type { ChunkFrame, Frame, FrameKind } from './types.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
export const DEFAULT_BUFFERED_AMOUNT_HIGH = 1 * 1024 * 1024;
export const DEFAULT_BUFFERED_AMOUNT_LOW = 256 * 1024;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60000;
export const DEFAULT_REASSEMBLY_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_REASSEMBLY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_PENDING_MESSAGES = 64;
export const DEFAULT_SIGNAL_PATH = '/subduct';
export const DEFAULT_MAX_SIGNAL_PAYLOAD = 64 * 1024;

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

function splitString(str: string, size: number): string[] {
  if (str.length <= size) return [str];
  const out: string[] = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

export function serializeFrames(frame: Frame, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const json = JSON.stringify(frame);
  if (json.length <= chunkSize) return [json];
  const cid = randomId();
  const parts = splitString(json, chunkSize);
  return parts.map((data, seq) =>
    JSON.stringify({ kind: 'chunk', cid, seq, total: parts.length, data } satisfies ChunkFrame),
  );
}

interface PendingEntry {
  parts: Array<string | undefined>;
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

  ingest(raw: string): Frame | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const kind = (parsed as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !VALID_FRAME_KINDS.has(kind as FrameKind)) return null;
    const frame = parsed as Frame;
    if (frame.kind !== 'chunk') return frame;
    if (
      typeof frame.cid !== 'string' ||
      typeof frame.seq !== 'number' ||
      typeof frame.total !== 'number' ||
      typeof frame.data !== 'string' ||
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
        parts: Array.from<string | undefined>({ length: frame.total }),
        received: 0,
        total: frame.total,
        bytes: 0,
        deadline: Date.now() + this.timeoutMs,
      };
      this.pending.set(frame.cid, entry);
    }
    if (entry.total !== frame.total) return null;
    if (entry.parts[frame.seq] !== undefined) return null;
    if (entry.bytes + frame.data.length > this.maxBytes) {
      this.pending.delete(frame.cid);
      return null;
    }
    entry.parts[frame.seq] = frame.data;
    entry.received += 1;
    entry.bytes += frame.data.length;
    entry.deadline = Date.now() + this.timeoutMs;
    if (entry.received !== entry.total) return null;
    this.pending.delete(frame.cid);
    try {
      const merged = JSON.parse(entry.parts.join('')) as unknown;
      if (!merged || typeof merged !== 'object') return null;
      const innerKind = (merged as { kind?: unknown }).kind;
      if (typeof innerKind !== 'string' || !VALID_FRAME_KINDS.has(innerKind as FrameKind))
        return null;
      if (innerKind === 'chunk') return null;
      return merged as Frame;
    } catch {
      return null;
    }
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
