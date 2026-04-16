import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SignalingMessage } from '../shared/types.js';
import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MAX_SIGNAL_PAYLOAD,
  DEFAULT_SIGNAL_PATH,
  randomId,
} from '../shared/protocol.js';

export interface SignalingOptions {
  port?: number;
  host?: string;
  path?: string;
  server?: HttpServer;
  wss?: WebSocketServer;
  allowedOrigins?: string[] | ((origin: string | undefined) => boolean);
  verifyToken?: (token: string | null, req: IncomingMessage) => boolean | Promise<boolean>;
  handshakeTimeoutMs?: number;
  maxPayload?: number;
  iceServers: RTCIceServer[];
  onSession: (session: SignalingSession) => void;
}

export interface SignalingSession {
  readonly sessionId: string;
  readonly remoteAddress: string | undefined;
  send(msg: SignalingMessage): void;
  onMessage(handler: (msg: SignalingMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
  isAlive(): boolean;
}

export interface SignalingHandle {
  readonly port: number;
  close(): Promise<void>;
}

export async function startSignaling(opts: SignalingOptions): Promise<SignalingHandle> {
  const path = opts.path ?? DEFAULT_SIGNAL_PATH;
  const handshakeTimeout = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const maxPayload = opts.maxPayload ?? DEFAULT_MAX_SIGNAL_PAYLOAD;

  let ownsHttpServer = false;
  let ownsWss = false;
  let httpServer = opts.server;
  let wss = opts.wss;

  if (!wss) {
    if (!httpServer) {
      httpServer = createServer();
      ownsHttpServer = true;
    }
    wss = new WebSocketServer({ noServer: true, maxPayload });
    ownsWss = true;

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin as string | undefined;
      if (!allowedOrigin(origin, opts.allowedOrigins)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        wss!.emit('connection', ws, req);
      });
    });

    if (ownsHttpServer) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          httpServer!.off('listening', onListen);
          reject(err);
        };
        const onListen = (): void => {
          httpServer!.off('error', onError);
          resolve();
        };
        httpServer!.once('error', onError);
        httpServer!.once('listening', onListen);
        httpServer!.listen(opts.port ?? 0, opts.host ?? '0.0.0.0');
      });
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    void handleConnection(ws, req, opts, handshakeTimeout);
  });

  const port =
    httpServer && (httpServer.address() as { port?: number } | null)?.port
      ? (httpServer.address() as { port: number }).port
      : (opts.port ?? 0);

  return {
    port,
    close: async () => {
      if (ownsWss && wss) {
        await new Promise<void>((resolve) => wss!.close(() => resolve()));
      }
      if (ownsHttpServer && httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      }
    },
  };
}

async function handleConnection(
  ws: WebSocket,
  req: IncomingMessage,
  opts: SignalingOptions,
  handshakeTimeout: number,
): Promise<void> {
  if (opts.verifyToken) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const token = url.searchParams.get('token');
      const ok = await opts.verifyToken(token, req);
      if (!ok) {
        try {
          ws.close(4001, 'unauthorized');
        } catch {
          // noop
        }
        return;
      }
    } catch {
      try {
        ws.close(4001, 'unauthorized');
      } catch {
        // noop
      }
      return;
    }
  }

  const sessionId = randomId();
  const remoteAddress = req.socket.remoteAddress ?? undefined;
  let messageHandler: ((m: SignalingMessage) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let closed = false;
  let opened = false;

  const handshakeTimer = setTimeout(() => {
    if (!opened && !closed) {
      try {
        ws.close(4000, 'handshake-timeout');
      } catch {
        // noop
      }
    }
  }, handshakeTimeout);

  const session: SignalingSession = {
    sessionId,
    remoteAddress,
    send: (m) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    },
    onMessage: (h) => {
      messageHandler = h;
    },
    onClose: (h) => {
      closeHandler = h;
    },
    close: () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        try {
          ws.close();
        } catch {
          // noop
        }
      }
    },
    isAlive: () => !closed,
  };

  ws.on('message', (data) => {
    opened = true;
    let parsed: unknown;
    try {
      const text = typeof data === 'string' ? data : (data as Buffer).toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const msg = parsed as SignalingMessage;
    if (typeof msg.type !== 'string') return;
    messageHandler?.(msg);
  });

  ws.on('close', () => {
    closed = true;
    clearTimeout(handshakeTimer);
    const h = closeHandler;
    closeHandler = null;
    messageHandler = null;
    h?.();
  });

  ws.on('error', () => {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    try {
      ws.terminate();
    } catch {
      // noop
    }
    const h = closeHandler;
    closeHandler = null;
    messageHandler = null;
    h?.();
  });

  opts.onSession(session);
  session.send({ type: 'hello', sessionId, iceServers: opts.iceServers });
}

function allowedOrigin(
  origin: string | undefined,
  allowed: SignalingOptions['allowedOrigins'],
): boolean {
  if (!allowed) return true;
  if (typeof allowed === 'function') return allowed(origin);
  if (allowed.includes('*')) return true;
  if (origin === undefined) return false;
  return allowed.includes(origin);
}
