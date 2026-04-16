# subduct

An Express-style server and axios-style client that talk over a WebRTC DataChannel instead of HTTP. You never touch a peer connection, it's just `app.get()` and `client.post()`.

## Install

```bash
npm install subduct
```

Node 18.17 or newer. Browsers: anything modern with `RTCPeerConnection`.

## Server

```ts
import { createApp } from 'subduct/server';

const app = createApp({ signal: 'ws://0.0.0.0:3000' });

app.use((req, _res, next) => {
  console.log(req.method, req.path);
  next();
});

app.get('/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.post('/echo', (req, res) => {
  res.status(201).json({ echo: req.body });
});

await app.listen();
```

`req` has `method`, `path`, `params`, `query`, `headers`, `body`, `sessionId`, `signal` (AbortSignal, fires when the client cancels), plus `req.get(name)`. `res` has `status`, `set`, `type`, `json`, `send`, `end`, `sendStatus` and is chainable. Middleware, scoped prefixes, route params, and async handlers work like Express.

## Client - session

```ts
import { Session } from 'subduct/client';

const client = new Session({ signal: 'wss://host:3000' });
await client.connect();

const a = await client.get('/users/1');
const b = await client.post('/users', { name: 'alice' });

client.close();
```

## Client - ephemeral

```ts
import { get, post } from 'subduct/client';

const res = await get('wss://host:3000/users/42');
await post('wss://host:3000/echo', { hello: 'world' });
```

Each such request opens, completes, closes. Use a session to avoid connection overhead.

## Request options

```ts
await client.request({
  method: 'POST',
  url: '/upload',
  headers: { 'x-trace': 'abc' },
  body: formData,
  params: { ref: 'v2' },
  responseType: 'blob',
  timeout: 10_000,
  abortSignal: controller.signal,
});
```

Body: plain object / array / number / boolean → JSON; string → text; `Blob` / `ArrayBuffer` / `TypedArray` → raw bytes; `FormData` → multipart; `URLSearchParams` → urlencoded. Response types: `auto`, `json`, `text`, `blob`, `arraybuffer`.

## Under the hood

The browser opens a WebSocket to your signal URL. The server sends a session id and ICE servers, the browser builds an `RTCPeerConnection` and a single `RTCDataChannel`, they exchange SDP and ICE over the WebSocket, the DataChannel opens, the WebSocket closes. After that every message on the channel is a binary envelope - a length-prefixed JSON header followed by raw body bytes chunked and backpressure-aware for large payloads. Binary bodies travel as the raw bytes, no base64. Aborted requests send a cancel frame so the server's `req.signal` fires.

## Limitations

- One DataChannel per connection. No streams, no server-sent-events.
- Ephemeral `get()`/`post()` spin up a full peer connection per call.
- `FormData` files are still base64-embedded in the header's form payload; multi-part binary is not plumbed through. Send a single `Blob` / `ArrayBuffer` if you need zero-overhead binary upload.
- No automatic ICE restart. A broken connection surfaces as an error; opening the next request reconnects.
- Signaling requires a WebSocket endpoint you control. For production, terminate TLS in front of it (pass your own `http.Server` via `signal: { server }`) and set `verifyToken` and `allowedOrigins`. The default origin check is permissive.

## License

MIT
