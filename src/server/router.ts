import type { Method } from '../shared/types.js';
import type { ServerRequest } from './request.js';
import type { ServerResponse } from './response.js';

export type NextFn = (err?: unknown) => void;
export type Handler = (
  req: ServerRequest,
  res: ServerResponse,
  next: NextFn,
) => void | Promise<void>;
export type ErrorHandler = (
  err: unknown,
  req: ServerRequest,
  res: ServerResponse,
  next: NextFn,
) => void | Promise<void>;

interface CompiledPattern {
  regex: RegExp;
  keys: string[];
  prefix: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(pattern: string): CompiledPattern {
  const keys: string[] = [];
  const trimmed = pattern.startsWith('/') ? pattern.slice(1) : pattern;
  const parts = trimmed.split('/');
  const regexParts = parts.map((part) => {
    if (part.startsWith(':')) {
      const optional = part.endsWith('?');
      const name = optional ? part.slice(1, -1) : part.slice(1);
      keys.push(name);
      return optional ? '([^/]*)' : '([^/]+)';
    }
    if (part === '*') {
      keys.push('wildcard');
      return '(.*)';
    }
    return escapeRegex(part);
  });
  const body = regexParts.join('/');
  return {
    regex: new RegExp(`^/${body}/?$`),
    keys,
    prefix: false,
  };
}

function compilePrefix(prefix: string): CompiledPattern {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const keys: string[] = [];
  const parts = normalized.split('/').filter(Boolean);
  const regexParts: string[] = [];
  for (const part of parts) {
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      regexParts.push('([^/]+)');
    } else {
      regexParts.push(escapeRegex(part));
    }
  }
  const body = regexParts.length === 0 ? '' : `/${regexParts.join('/')}`;
  return {
    regex: new RegExp(`^${body}(?=/|$)`),
    keys,
    prefix: true,
  };
}

interface StackEntry {
  method: Method | null;
  pattern: CompiledPattern;
  handlers: Handler[];
  errorHandlers: ErrorHandler[];
}

function isErrorHandler(fn: Handler | ErrorHandler): fn is ErrorHandler {
  return fn.length >= 4;
}

export class Router {
  private stack: StackEntry[] = [];

  use(...args: Array<string | Handler | ErrorHandler>): this {
    let path = '/';
    let fns: Array<Handler | ErrorHandler>;
    if (typeof args[0] === 'string') {
      path = args[0];
      fns = args.slice(1) as Array<Handler | ErrorHandler>;
    } else {
      fns = args as Array<Handler | ErrorHandler>;
    }
    for (const fn of fns) {
      const entry: StackEntry = {
        method: null,
        pattern: compilePrefix(path),
        handlers: [],
        errorHandlers: [],
      };
      if (isErrorHandler(fn)) entry.errorHandlers.push(fn);
      else entry.handlers.push(fn as Handler);
      this.stack.push(entry);
    }
    return this;
  }

  register(method: Method, path: string, handlers: Handler[]): this {
    this.stack.push({
      method,
      pattern: compilePath(path),
      handlers,
      errorHandlers: [],
    });
    return this;
  }

  dispatch(req: ServerRequest, res: ServerResponse): Promise<void> {
    return new Promise<void>((resolve) => {
      let idx = 0;
      const originalParams = { ...req.params };

      const advance = (err?: unknown): void => {
        if (res.ended) {
          resolve();
          return;
        }
        if (idx >= this.stack.length) {
          if (err) {
            res.status(500).send({ error: String((err as Error)?.message ?? err) });
          } else {
            res.status(404).send({ error: `Cannot ${req.method} ${req.path}` });
          }
          resolve();
          return;
        }
        const entry = this.stack[idx++];
        if (!entry) {
          advance(err);
          return;
        }

        if (entry.method && entry.method !== req.method) {
          advance(err);
          return;
        }

        const match = entry.pattern.regex.exec(req.path);
        if (!match) {
          advance(err);
          return;
        }

        const params: Record<string, string> = { ...originalParams };
        for (let i = 0; i < entry.pattern.keys.length; i++) {
          const k = entry.pattern.keys[i]!;
          const v = match[i + 1];
          if (v !== undefined) params[k] = decodeURIComponentSafe(v);
        }
        req.params = params;

        if (err) {
          if (entry.errorHandlers.length === 0) {
            advance(err);
            return;
          }
          runErrorHandlers(entry.errorHandlers, err, req, res, advance);
          return;
        }

        if (entry.handlers.length === 0) {
          advance();
          return;
        }
        runHandlers(entry.handlers, req, res, advance);
      };

      advance();
    });
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function runHandlers(
  handlers: Handler[],
  req: ServerRequest,
  res: ServerResponse,
  done: NextFn,
): void {
  let i = 0;
  const step = (err?: unknown): void => {
    if (err) {
      done(err);
      return;
    }
    if (res.ended) {
      done();
      return;
    }
    if (i >= handlers.length) {
      done();
      return;
    }
    const h = handlers[i++]!;
    let called = false;
    const next: NextFn = (e) => {
      if (called) return;
      called = true;
      step(e);
    };
    try {
      const ret = h(req, res, next);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        (ret as Promise<unknown>).then(
          () => {
            if (!called && !res.ended) {
              called = true;
              step();
            } else if (!called && res.ended) {
              called = true;
              done();
            }
          },
          (e: unknown) => {
            if (!called) {
              called = true;
              step(e);
            }
          },
        );
      }
    } catch (e) {
      if (!called) {
        called = true;
        step(e);
      }
    }
  };
  step();
}

function runErrorHandlers(
  handlers: ErrorHandler[],
  err: unknown,
  req: ServerRequest,
  res: ServerResponse,
  done: NextFn,
): void {
  let i = 0;
  let currentErr: unknown = err;
  const step = (nextErr?: unknown): void => {
    if (nextErr !== undefined) currentErr = nextErr;
    if (res.ended) {
      done();
      return;
    }
    if (i >= handlers.length) {
      done(currentErr);
      return;
    }
    const h = handlers[i++]!;
    let called = false;
    const next: NextFn = (e) => {
      if (called) return;
      called = true;
      step(e);
    };
    try {
      const ret = h(currentErr, req, res, next);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        (ret as Promise<unknown>).then(
          () => {
            if (!called && !res.ended) {
              called = true;
              step();
            } else if (!called && res.ended) {
              called = true;
              done();
            }
          },
          (e: unknown) => {
            if (!called) {
              called = true;
              step(e);
            }
          },
        );
      }
    } catch (e) {
      if (!called) {
        called = true;
        step(e);
      }
    }
  };
  step();
}
