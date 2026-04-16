import './webrtc.js';

import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  DEFAULT_SIGNAL_PATH,
} from '../shared/protocol.js';
import type { Method, RequestMessage, ResponseMessage, SignalingMessage } from '../shared/types.js';
import { Router, type ErrorHandler, type Handler } from './router.js';
import { ServerRequest } from './request.js';
import { ServerResponse } from './response.js';
import { Peer } from './peer.js';
import {
  startSignaling,
  type SignalingHandle,
  type SignalingOptions,
  type SignalingSession,
} from './signaling.js';
import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';

export interface CreateAppOptions {
  signal?: string | SignalConfig;
  iceServers?: RTCIceServer[];
  chunkSize?: number;
  verifyToken?: SignalingOptions['verifyToken'];
  allowedOrigins?: SignalingOptions['allowedOrigins'];
  handshakeTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface SignalConfig {
  port?: number;
  host?: string;
  path?: string;
  server?: HttpServer;
  wss?: WebSocketServer;
  url?: string;
}

export interface SubductApp {
  use(...args: Array<string | Handler | ErrorHandler>): SubductApp;
  get(path: string, ...handlers: Handler[]): SubductApp;
  post(path: string, ...handlers: Handler[]): SubductApp;
  put(path: string, ...handlers: Handler[]): SubductApp;
  patch(path: string, ...handlers: Handler[]): SubductApp;
  delete(path: string, ...handlers: Handler[]): SubductApp;
  head(path: string, ...handlers: Handler[]): SubductApp;
  options(path: string, ...handlers: Handler[]): SubductApp;
  all(path: string, ...handlers: Handler[]): SubductApp;
  listen(port?: number, host?: string): Promise<SubductHandle>;
  close(): Promise<void>;
}

export interface SubductHandle {
  readonly port: number;
  close(): Promise<void>;
}

class App implements SubductApp {
  private readonly router = new Router();
  private readonly opts: CreateAppOptions;
  private readonly peers = new Set<Peer>();
  private readonly requestControllers = new Map<string, AbortController>();
  private signaling: SignalingHandle | null = null;
  private closed = false;

  constructor(opts: CreateAppOptions) {
    this.opts = opts;
  }

  use(...args: Array<string | Handler | ErrorHandler>): this {
    this.router.use(...args);
    return this;
  }

  private add(method: Method, path: string, handlers: Handler[]): this {
    this.router.register(method, path, handlers);
    return this;
  }

  get(path: string, ...handlers: Handler[]): this {
    return this.add('GET', path, handlers);
  }
  post(path: string, ...handlers: Handler[]): this {
    return this.add('POST', path, handlers);
  }
  put(path: string, ...handlers: Handler[]): this {
    return this.add('PUT', path, handlers);
  }
  patch(path: string, ...handlers: Handler[]): this {
    return this.add('PATCH', path, handlers);
  }
  delete(path: string, ...handlers: Handler[]): this {
    return this.add('DELETE', path, handlers);
  }
  head(path: string, ...handlers: Handler[]): this {
    return this.add('HEAD', path, handlers);
  }
  options(path: string, ...handlers: Handler[]): this {
    return this.add('OPTIONS', path, handlers);
  }
  all(path: string, ...handlers: Handler[]): this {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as Method[]) {
      this.router.register(m, path, handlers);
    }
    return this;
  }

  async listen(port?: number, host?: string): Promise<SubductHandle> {
    if (this.closed) throw new Error('subduct: app is closed');
    const signalCfg = this.resolveSignal(port, host);
    const iceServers = this.opts.iceServers ?? DEFAULT_ICE_SERVERS;
    const chunkSize = this.opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const handshakeTimeoutMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const heartbeatTimeoutMs = this.opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

    const signalingOpts: SignalingOptions = {
      port: signalCfg.port,
      host: signalCfg.host,
      path: signalCfg.path ?? DEFAULT_SIGNAL_PATH,
      server: signalCfg.server,
      wss: signalCfg.wss,
      allowedOrigins: this.opts.allowedOrigins,
      verifyToken: this.opts.verifyToken,
      handshakeTimeoutMs,
      iceServers,
      onSession: (session) =>
        this.handleSession(session, iceServers, chunkSize, handshakeTimeoutMs, heartbeatTimeoutMs),
    };

    this.signaling = await startSignaling(signalingOpts);
    return {
      port: this.signaling.port,
      close: () => this.close(),
    };
  }

  private resolveSignal(port?: number, host?: string): SignalConfig {
    const raw = this.opts.signal;
    if (!raw) return { port: port ?? 0, host: host ?? '0.0.0.0' };
    if (typeof raw === 'string') {
      try {
        const u = new URL(raw);
        const parsedPort = u.port ? Number(u.port) : u.protocol === 'wss:' ? 443 : 80;
        return {
          port: port ?? parsedPort,
          host: host ?? (u.hostname || '0.0.0.0'),
          path: u.pathname === '/' ? DEFAULT_SIGNAL_PATH : u.pathname,
        };
      } catch {
        return { port: port ?? 0, host: host ?? '0.0.0.0' };
      }
    }
    const cfg: SignalConfig = { ...raw };
    if (port !== undefined) cfg.port = port;
    if (host !== undefined) cfg.host = host;
    return cfg;
  }

  private handleSession(
    session: SignalingSession,
    iceServers: RTCIceServer[],
    chunkSize: number,
    handshakeTimeoutMs: number,
    heartbeatTimeoutMs: number,
  ): void {
    const peer = new Peer({
      sessionId: session.sessionId,
      iceServers,
      chunkSize,
      remoteAddress: session.remoteAddress,
      handshakeTimeoutMs,
      heartbeatTimeoutMs,
      onRequest: (p, msg, body) => this.dispatchRequest(p, msg, body),
      onCancel: (_p, requestId) => this.cancelRequest(requestId),
      onOpen: () => session.close(),
      onClose: (p) => {
        this.peers.delete(p);
      },
      onIceCandidate: (_p, candidate) => {
        session.send({
          type: 'ice',
          sessionId: session.sessionId,
          candidate: candidate ? candidate.toJSON() : null,
        });
      },
    });
    this.peers.add(peer);

    session.onMessage(async (msg: SignalingMessage) => {
      try {
        if (msg.type === 'offer') {
          const sdp = await peer.acceptOffer(msg.sdp);
          session.send({ type: 'answer', sessionId: session.sessionId, sdp });
        } else if (msg.type === 'ice') {
          await peer.addRemoteIce(msg.candidate);
        }
      } catch (err) {
        session.send({
          type: 'error',
          sessionId: session.sessionId,
          code: 'signaling-error',
          message: String((err as Error)?.message ?? err),
        });
        peer.close();
      }
    });
  }

  private dispatchRequest(peer: Peer, msg: RequestMessage, body: Uint8Array): void {
    const controller = new AbortController();
    this.requestControllers.set(msg.id, controller);
    const req = new ServerRequest({
      id: msg.id,
      method: msg.method,
      path: msg.path,
      query: msg.query ?? {},
      headers: msg.headers ?? {},
      bodyEncoding: msg.bodyEncoding,
      headerBody: msg.body,
      bodyBytes: body,
      sessionId: peer.sessionId,
      remoteAddress: peer.remoteAddress,
      signal: controller.signal,
    });
    const res = new ServerResponse(msg.id, (response: ResponseMessage, bytes: Uint8Array) => {
      this.requestControllers.delete(msg.id);
      peer.sendResponse(response, bytes);
    });
    void this.router.dispatch(req, res).catch((err: unknown) => {
      this.requestControllers.delete(msg.id);
      if (!res.ended) res.status(500).json({ error: String((err as Error)?.message ?? err) });
    });
  }

  private cancelRequest(requestId: string): void {
    const controller = this.requestControllers.get(requestId);
    if (!controller) return;
    this.requestControllers.delete(requestId);
    controller.abort();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.requestControllers.values()) controller.abort();
    this.requestControllers.clear();
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    if (this.signaling) {
      await this.signaling.close();
      this.signaling = null;
    }
  }
}

export function createApp(opts: CreateAppOptions = {}): SubductApp {
  return new App(opts);
}
