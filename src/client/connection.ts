import {
  DEFAULT_BUFFERED_AMOUNT_HIGH,
  DEFAULT_BUFFERED_AMOUNT_LOW,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  FrameAssembler,
  serializeFrames,
} from '../shared/protocol.js';
import type { Frame, RequestMessage, ResponseMessage, SignalingMessage } from '../shared/types.js';
import { normalizeSignalUrl } from './url.js';

export interface ConnectionOptions {
  signal: string;
  iceServers?: RTCIceServer[];
  token?: string;
  chunkSize?: number;
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed';

interface PendingRequest {
  resolve: (msg: ResponseMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  abortSignal: AbortSignal | null;
  abortHandler: (() => void) | null;
}

export class Connection {
  private readonly opts: ConnectionOptions;
  private readonly chunkSize: number;
  private readonly handshakeTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private state: ConnectionState = 'idle';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly assembler = new FrameAssembler();
  private readonly bufferedWaiters = new Set<() => void>();
  private openPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTs = 0;

  constructor(opts: ConnectionOptions) {
    this.opts = opts;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.handshakeTimeout = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.heartbeatInterval = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  getState(): ConnectionState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state === 'open' && this.dc?.readyState === 'open';
  }

  open(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closed') {
      return Promise.reject(new Error('subduct: connection is closed; create a new one'));
    }
    if (this.openPromise) return this.openPromise;
    this.openPromise = this.doOpen().catch((err: unknown) => {
      this.openPromise = null;
      this.teardown();
      throw err as Error;
    });
    return this.openPromise;
  }

  private async doOpen(): Promise<void> {
    this.state = 'connecting';
    const signalUrl = normalizeSignalUrl(
      this.opts.token ? appendToken(this.opts.signal, this.opts.token) : this.opts.signal,
    );

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE_SERVERS });
    this.pc = pc;

    const dc = pc.createDataChannel('subduct', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DEFAULT_BUFFERED_AMOUNT_LOW;
    this.dc = dc;

    const dcReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`subduct: datachannel did not open within ${this.handshakeTimeout}ms`));
      }, this.handshakeTimeout);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (ev: Event): void => {
        cleanup();
        reject(
          (ev as RTCErrorEvent).error ?? new Error('subduct: datachannel error during handshake'),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        dc.removeEventListener('open', onOpen);
        dc.removeEventListener('error', onError);
      };
      dc.addEventListener('open', onOpen);
      dc.addEventListener('error', onError);
    });

    dc.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data));
    dc.addEventListener('close', () => this.teardown());
    dc.addEventListener('bufferedamountlow', () => this.drainWaiters());

    const ws = await openWebSocket(signalUrl, this.handshakeTimeout);
    this.ws = ws;

    const signaling = new SignalingClient(ws);
    const helloMsg = await signaling.waitFor('hello', this.handshakeTimeout);
    this.sessionId = helloMsg.sessionId;

    pc.addEventListener('icecandidate', (ev) => {
      if (ws.readyState !== ws.OPEN || this.sessionId === null) return;
      signaling.send({
        type: 'ice',
        sessionId: this.sessionId,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      });
    });

    pc.addEventListener('connectionstatechange', () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this.teardown();
    });

    signaling.onMessage(async (msg) => {
      try {
        if (msg.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        } else if (msg.type === 'ice' && msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        } else if (msg.type === 'error') {
          this.failAllPending(new Error(`signaling: ${msg.message}`));
        }
      } catch {
        // noop
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.send({
      type: 'offer',
      sessionId: this.sessionId,
      sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
    });

    await dcReady;

    try {
      ws.close();
    } catch {
      // noop
    }
    this.ws = null;

    this.state = 'open';
    this.openPromise = null;
    this.startHeartbeat();
  }

  async request(
    message: RequestMessage,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<ResponseMessage> {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.state !== 'open') await this.open();
    if (!this.dc || this.dc.readyState !== 'open') throw new Error('subduct: datachannel not open');

    return new Promise<ResponseMessage>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve,
        reject,
        timer: null,
        abortSignal: abortSignal ?? null,
        abortHandler: null,
      };

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.cleanupPending(message.id);
          reject(
            new DOMException(`subduct: request timed out after ${timeoutMs}ms`, 'TimeoutError'),
          );
        }, timeoutMs);
      }

      if (abortSignal) {
        entry.abortHandler = () => {
          this.cleanupPending(message.id);
          void this.sendFrame({ kind: 'cancel', id: message.id }).catch(() => {});
          reject(new DOMException('aborted', 'AbortError'));
        };
        abortSignal.addEventListener('abort', entry.abortHandler, { once: true });
      }

      this.pending.set(message.id, entry);
      void this.sendFrame(message).catch((err: unknown) => {
        this.cleanupPending(message.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private cleanupPending(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abortSignal && entry.abortHandler) {
      entry.abortSignal.removeEventListener('abort', entry.abortHandler);
    }
    this.pending.delete(id);
  }

  private async sendFrame(frame: Frame): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('subduct: datachannel not open');
    const parts = serializeFrames(frame, this.chunkSize);
    for (const part of parts) {
      if (dc.bufferedAmount > DEFAULT_BUFFERED_AMOUNT_HIGH) {
        await new Promise<void>((resolve) => this.bufferedWaiters.add(resolve));
      }
      if (dc.readyState !== 'open') throw new Error('subduct: datachannel closed mid-send');
      dc.send(part);
    }
  }

  private drainWaiters(): void {
    const waiters = Array.from(this.bufferedWaiters);
    this.bufferedWaiters.clear();
    for (const w of waiters) w();
  }

  private onMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : asString(data);
    if (text === null) return;
    const frame = this.assembler.ingest(text);
    if (!frame) return;
    if (frame.kind === 'response') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.cleanupPending(frame.id);
      entry.resolve(frame);
    } else if (frame.kind === 'error') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.cleanupPending(frame.id);
      entry.reject(new Error(`${frame.code}: ${frame.message}`));
    } else if (frame.kind === 'pong') {
      this.lastPongTs = Date.now();
    } else if (frame.kind === 'ping') {
      void this.sendFrame({ kind: 'pong', ts: frame.ts }).catch(() => {});
    }
  }

  private failAllPending(err: Error): void {
    const ids = Array.from(this.pending.keys());
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.cleanupPending(id);
      entry.reject(err);
    }
  }

  private startHeartbeat(): void {
    this.lastPongTs = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastPongTs > this.heartbeatTimeout) {
        this.teardown();
        return;
      }
      void this.sendFrame({ kind: 'ping', ts: now }).catch(() => {});
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.stopHeartbeat();
    this.failAllPending(new Error('subduct: connection closed'));
    this.drainWaiters();
    this.assembler.clear();
    try {
      this.dc?.close();
    } catch {
      // noop
    }
    try {
      this.pc?.close();
    } catch {
      // noop
    }
    try {
      this.ws?.close();
    } catch {
      // noop
    }
    this.dc = null;
    this.pc = null;
    this.ws = null;
  }
}

function asString(data: unknown): string | null {
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

function appendToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set('token', token);
  return u.toString();
}

function openWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // noop
      }
      reject(new Error(`subduct: signaling handshake timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`subduct: signaling websocket error at ${url}`));
    };
  });
}

class SignalingClient {
  private readonly handlers = new Set<(m: SignalingMessage) => void>();
  private readonly buffer: SignalingMessage[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const msg = parsed as SignalingMessage;
      if (this.handlers.size === 0) {
        this.buffer.push(msg);
      } else {
        for (const h of this.handlers) h(msg);
      }
    });
  }

  send(msg: SignalingMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  onMessage(handler: (m: SignalingMessage) => void): void {
    this.handlers.add(handler);
    const buffered = this.buffer.splice(0);
    for (const m of buffered) handler(m);
  }

  waitFor<K extends SignalingMessage['type']>(
    type: K,
    timeoutMs: number,
  ): Promise<Extract<SignalingMessage, { type: K }>> {
    type Match = Extract<SignalingMessage, { type: K }>;
    return new Promise<Match>((resolve, reject) => {
      const finish = (): void => {
        this.handlers.delete(wrapped);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`subduct: timed out waiting for signaling ${type}`));
      }, timeoutMs);
      const wrapped = (m: SignalingMessage): void => {
        if (m.type === type) {
          finish();
          resolve(m as Match);
        }
      };
      for (let i = 0; i < this.buffer.length; i++) {
        const m = this.buffer[i]!;
        if (m.type === type) {
          this.buffer.splice(i, 1);
          clearTimeout(timer);
          resolve(m as Match);
          return;
        }
      }
      this.handlers.add(wrapped);
    });
  }
}
