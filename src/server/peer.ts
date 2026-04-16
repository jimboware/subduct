import {
  DEFAULT_BUFFERED_AMOUNT_HIGH,
  DEFAULT_BUFFERED_AMOUNT_LOW,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  FrameAssembler,
  serializeFrames,
} from '../shared/protocol.js';
import type { Frame, RequestMessage, ResponseMessage } from '../shared/types.js';

export interface PeerOptions {
  sessionId: string;
  iceServers: RTCIceServer[];
  chunkSize: number;
  remoteAddress?: string | undefined;
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  onRequest: (peer: Peer, message: RequestMessage) => void;
  onCancel?: (peer: Peer, requestId: string) => void;
  onOpen?: (peer: Peer) => void;
  onClose?: (peer: Peer) => void;
  onError?: (peer: Peer, err: unknown) => void;
  onIceCandidate?: (peer: Peer, candidate: RTCIceCandidate | null) => void;
}

export class Peer {
  readonly sessionId: string;
  readonly remoteAddress?: string;
  private readonly pc: RTCPeerConnection;
  private readonly assembler = new FrameAssembler();
  private readonly chunkSize: number;
  private readonly heartbeatTimeout: number;
  private dc: RTCDataChannel | null = null;
  private opened = false;
  private closed = false;
  private readonly bufferedWaiters = new Set<() => void>();
  private readonly opts: PeerOptions;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTs = 0;

  constructor(opts: PeerOptions) {
    this.opts = opts;
    this.sessionId = opts.sessionId;
    this.remoteAddress = opts.remoteAddress;
    this.chunkSize = opts.chunkSize;
    this.heartbeatTimeout = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });

    this.handshakeTimer = setTimeout(() => {
      if (!this.opened) this.teardown();
    }, opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);

    this.pc.addEventListener('datachannel', (ev: RTCDataChannelEvent) => {
      this.bindDataChannel(ev.channel);
    });

    this.pc.addEventListener('icecandidate', (ev: RTCPeerConnectionIceEvent) => {
      this.opts.onIceCandidate?.(this, ev.candidate);
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.teardown();
    });
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription?.sdp ?? answer.sdp ?? '';
  }

  async addRemoteIce(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (candidate === null) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // noop
    }
  }

  private bindDataChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DEFAULT_BUFFERED_AMOUNT_LOW;

    dc.addEventListener('open', () => {
      this.opened = true;
      this.lastPingTs = Date.now();
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.startHeartbeatWatchdog();
      this.opts.onOpen?.(this);
    });

    dc.addEventListener('message', (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : asString(ev.data);
      if (raw === null) return;
      const frame = this.assembler.ingest(raw);
      if (!frame) return;
      this.handleFrame(frame);
    });

    dc.addEventListener('close', () => this.teardown());

    dc.addEventListener('error', (ev) => {
      this.opts.onError?.(this, (ev as RTCErrorEvent).error ?? new Error('datachannel error'));
    });

    dc.addEventListener('bufferedamountlow', () => this.drainWaiters());
  }

  private handleFrame(frame: Frame): void {
    switch (frame.kind) {
      case 'request':
        this.opts.onRequest(this, frame);
        return;
      case 'cancel':
        this.opts.onCancel?.(this, frame.id);
        return;
      case 'ping':
        this.lastPingTs = Date.now();
        void this.sendFrame({ kind: 'pong', ts: frame.ts }).catch(() => {});
        return;
      default:
        return;
    }
  }

  sendResponse(msg: ResponseMessage): void {
    void this.sendFrame(msg).catch((err: unknown) => {
      this.opts.onError?.(this, err);
    });
  }

  private async sendFrame(frame: Frame): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return;
    const parts = serializeFrames(frame, this.chunkSize);
    for (const part of parts) {
      if (dc.bufferedAmount > DEFAULT_BUFFERED_AMOUNT_HIGH) {
        await new Promise<void>((resolve) => this.bufferedWaiters.add(resolve));
      }
      if (this.closed || dc.readyState !== 'open') return;
      dc.send(part);
    }
  }

  private drainWaiters(): void {
    const waiters = Array.from(this.bufferedWaiters);
    this.bufferedWaiters.clear();
    for (const w of waiters) w();
  }

  private startHeartbeatWatchdog(): void {
    this.heartbeatTimer = setInterval(
      () => {
        if (Date.now() - this.lastPingTs > this.heartbeatTimeout) this.teardown();
      },
      Math.max(1000, Math.floor(this.heartbeatTimeout / 3)),
    );
  }

  isOpen(): boolean {
    return this.opened && !this.closed && this.dc?.readyState === 'open';
  }

  close(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.drainWaiters();
    this.assembler.clear();
    try {
      this.dc?.close();
    } catch {
      // noop
    }
    try {
      this.pc.close();
    } catch {
      // noop
    }
    this.opts.onClose?.(this);
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
