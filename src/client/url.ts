export interface ResolvedUrl {
  signal: string;
  path: string;
  query: Record<string, string | string[]>;
}

function isAbsolute(url: string): boolean {
  return /^wss?:\/\//i.test(url) || /^subduct(s)?:\/\//i.test(url) || /^https?:\/\//i.test(url);
}

function toWs(proto: string): string {
  if (proto === 'http:' || proto === 'subduct:') return 'ws:';
  if (proto === 'https:' || proto === 'subducts:') return 'wss:';
  return proto;
}

function parseQuery(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const params = new URLSearchParams(search);
  for (const key of new Set(Array.from(params.keys()))) {
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

export function resolveUrl(
  input: string | undefined,
  explicitSignal: string | undefined,
  explicitPath: string | undefined,
  baseUrl?: string,
): ResolvedUrl {
  if (input && isAbsolute(input)) {
    const u = new URL(input);
    u.protocol = toWs(u.protocol);
    const path = (u.pathname === '' ? '/' : u.pathname) + (u.search ?? '');
    const origin = `${u.protocol}//${u.host}`;
    return {
      signal: explicitSignal ?? origin,
      path: explicitPath ?? splitPath(path).path,
      query: explicitPath ? {} : splitPath(path).query,
    };
  }
  const rawPath = input ?? explicitPath ?? '/';
  const joined = baseUrl ? joinPath(baseUrl, rawPath) : rawPath;
  const { path, query } = splitPath(joined);
  if (!explicitSignal) {
    throw new Error(
      'subduct: signal URL is required (pass signal in options or use a full wss:// url)',
    );
  }
  return { signal: explicitSignal, path, query };
}

function joinPath(base: string, path: string): string {
  if (!path) return base;
  if (path.startsWith('/') && base.endsWith('/')) return base + path.slice(1);
  if (!path.startsWith('/') && !base.endsWith('/')) return `${base}/${path}`;
  return base + path;
}

function splitPath(p: string): { path: string; query: Record<string, string | string[]> } {
  const idx = p.indexOf('?');
  if (idx === -1) return { path: p, query: {} };
  return { path: p.slice(0, idx), query: parseQuery(p.slice(idx + 1)) };
}

export function mergeQuery(
  base: Record<string, string | string[]>,
  extra:
    | Record<
        string,
        string | number | boolean | null | undefined | Array<string | number | boolean>
      >
    | undefined,
): Record<string, string | string[]> {
  if (!extra) return base;
  const out: Record<string, string | string[]> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.map(String);
    else out[k] = String(v);
  }
  return out;
}

export function normalizeSignalUrl(input: string): string {
  const u = new URL(input);
  u.protocol = toWs(u.protocol);
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/subduct';
  return u.toString();
}
