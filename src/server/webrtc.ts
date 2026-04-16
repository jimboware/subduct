import * as ndc from 'node-datachannel/polyfill';

const g = globalThis as unknown as Record<string, unknown>;
for (const [key, value] of Object.entries(ndc)) {
  if (key === 'default') continue;
  if (typeof g[key] === 'undefined') g[key] = value;
}
