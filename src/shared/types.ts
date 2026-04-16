export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type BodyEncoding = 'none' | 'json' | 'text' | 'raw' | 'form' | 'urlencoded';

export interface FormFieldString {
  kind: 'string';
  value: string;
}

export interface FormFieldBlob {
  kind: 'blob';
  name: string;
  type: string;
  data: string;
}

export type FormField = FormFieldString | FormFieldBlob;

export interface FormPayload {
  fields: Array<[string, FormField]>;
}

export type Headers = Record<string, string>;

export interface RequestMessage {
  kind: 'request';
  id: string;
  method: Method;
  path: string;
  query: Record<string, string | string[]>;
  headers: Headers;
  bodyEncoding: BodyEncoding;
  body: unknown;
}

export interface ResponseMessage {
  kind: 'response';
  id: string;
  status: number;
  statusText: string;
  headers: Headers;
  bodyEncoding: BodyEncoding;
  body: unknown;
}

export interface ErrorMessage {
  kind: 'error';
  id: string;
  code: string;
  message: string;
}

export interface CancelMessage {
  kind: 'cancel';
  id: string;
}

export interface PingMessage {
  kind: 'ping';
  ts: number;
}

export interface PongMessage {
  kind: 'pong';
  ts: number;
}

export interface ChunkFrame {
  kind: 'chunk';
  cid: string;
  seq: number;
  total: number;
}

export type Frame =
  | RequestMessage
  | ResponseMessage
  | ErrorMessage
  | CancelMessage
  | PingMessage
  | PongMessage
  | ChunkFrame;

export type FrameKind = Frame['kind'];

export interface SignalingOffer {
  type: 'offer';
  sessionId: string;
  sdp: string;
}

export interface SignalingAnswer {
  type: 'answer';
  sessionId: string;
  sdp: string;
}

export interface SignalingIce {
  type: 'ice';
  sessionId: string;
  candidate: RTCIceCandidateInit | null;
}

export interface SignalingError {
  type: 'error';
  sessionId?: string;
  code: string;
  message: string;
}

export interface SignalingHello {
  type: 'hello';
  sessionId: string;
  iceServers: RTCIceServer[];
}

export type SignalingMessage =
  | SignalingOffer
  | SignalingAnswer
  | SignalingIce
  | SignalingError
  | SignalingHello;
