You are taking over an in-progress TypeScript npm package called **subduct** at `D:\Code\jimboware\subduct`. It replaces HTTP between browser and server with WebRTC DataChannels — Express-like server API, axios-like client API, invisible to the DevTools Network tab. Published with two subpath entrypoints `subduct/server` (Node) and `subduct/client` (browser), built via `tshy`.

Your job is to take this from "working proof of concept" to "ready to publish". Do a full audit, find every issue, and FIX them. Don't just report — fix.

## Phase 1: Research (parallel agents)

Launch these as concurrent research agents in a single message:

1. **oxfmt** — current (2025/2026) state of oxfmt (the Oxc project formatter). Is it stable enough to be the sole formatter for a TS library? Install + config. How does it compare to Biome and Prettier for TS specifically. Gotchas. Ready-to-paste config.

2. **oxlint** — current state of oxlint. Recommended rule set for a strict TS library. Does it cover TS types, unused imports, complexity, import order? What's missing vs eslint-with-typescript-eslint, and does it matter for this project? Ready-to-paste config.

3. **npm publish readiness** — what a top-tier TS library in 2026 needs: `.npmrc`, `engines`, `peerDependencies` vs `dependencies`, npm `--provenance`, `files` vs `.npmignore`, CI publish-on-tag workflow, changelog discipline, what `publint` and `attw` catch vs miss, common first-publish footguns.

4. **WebRTC DataChannel production concerns** — what a library wrapping DataChannels needs that a demo doesn't: ICE restart, network change handling, backpressure under adversarial load, max-message-size attacks, signaling DoS, memory leaks from dangling peers, graceful shutdown, reconnection heuristics. Look at how simple-peer, peerjs, and mediasoup's data-channel path handle these.

## Phase 2: Read the codebase

Read every file in `src/`. Understand the architecture. Find everything wrong, fragile, redundant, unused, or not idiomatic. Specifically look for:

- Dead or unreachable code, unused imports, unused exports, unused types
- Redundant abstractions — if a helper is called once, inline it
- Missing error handling at real boundaries (not invented ones) and excess error handling at non-boundaries
- Race conditions in connection/session lifecycle, especially around reconnect and abort
- Memory leaks: dangling listeners, maps that grow, timers that don't clear
- API gaps: does the client response really expose everything it should, does middleware scope correctly, do all body encodings round-trip (FormData with files, URLSearchParams, Blob, ArrayBuffer, TypedArray, string, plain object)
- TypeScript weakness: loose types, `unknown` that should be narrowed, types that don't flow through the public API
- Inconsistent naming, error shapes, option shapes
- Cross-contamination: anything Node-only leaking into `src/client`, anything browser-only leaking into `src/server`
- Chunking correctness and whether backpressure is actually wired on both sides
- The ephemeral `executeRequest` path — does it leak the `Connection` if setup throws

## Phase 3: Fix everything

Fix every issue. Don't ask for permission. If you change the API surface to make it cleaner, that's fine — nothing is published yet. Two hard constraints from the original spec stay: (1) no comments in source files, ever; (2) the developer never touches WebRTC primitives.

## Phase 4: Tooling

- Install and configure **oxfmt** as the sole formatter. Add `format` and `format:check` scripts.
- Install and configure **oxlint** with a rule set appropriate for a strict TS library. Add a `lint` script.
- Add a `verify` script chaining `typecheck && lint && format:check && build && publint && attw --pack .`
- `publint` and `attw` must be fully green except node10 (subpath exports fundamentally can't resolve under node10 — acceptable).

## Phase 5: README

Rewrite `README.md`. It currently sounds AI-generated. Make it not. Short, direct, human. No bullet-list soup, no "comprehensive" / "powerful" / "blazing fast" / "robust" / "battle-tested", no em-dash sprays, no section called "Why". Just: one paragraph on what it is, install, a server snippet, a client snippet, one paragraph on what's happening underneath, a visibility note (DevTools Network is blind, `chrome://webrtc-internals` is not), limitations, license. Under 100 lines.

## Phase 6: Verify

Run the full chain end-to-end: typecheck, lint, format:check, build, publint, attw, `examples/smoke.mjs`, `examples/smoke-ephemeral.mjs`. Everything must pass before you're done.

## Rules

- No comments in source files. Ever.
- Work from conversation context. Don't create planning, decision, notes, or TODO files.
- If a tool behaves differently than you expected, verify by reading the actual source in `node_modules/`, not by assuming. (We already hit this with `node-datachannel/polyfill` not installing globals — see `src/server/webrtc.ts` for the workaround.)
- Windows + git-bash environment. Forward slashes in paths, Unix shell syntax.
- Don't break the `subduct/server` or `subduct/client` public entry shape — downstream consumers depend on the `exports` map that `tshy` generates.
- When done, report concisely: what changed, what was added, what's left.

Go.
