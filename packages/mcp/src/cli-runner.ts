// @poopdeck.gl/mcp
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/mcp contributors

/**
 * Shell-out helper for the EXECUTION tool family (`dataset_report`,
 * `build_dataset`, `validate_dataset`) — only ever invoked when the server is
 * started with `--allow-cli` (off by default; see `config.ts`). Resolves the
 * `stt-optimize`/`stt-build`/`stt-validate` binaries from an explicit
 * override, `target/release/` (searched upward from CWD — this repo's Cargo
 * workspace build output), or falls back to a bare command name so
 * `child_process.spawn` resolves it via `PATH` (works once the binaries are
 * `cargo install`ed or otherwise on `PATH`, e.g. in a packaged deployment
 * where this server doesn't live inside the STT source tree).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface RunResult {
  bin: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

/** Output is capped (each stream) so a runaway/verbose CLI invocation can't blow up a tool response. */
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS
    ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated, ${s.length - MAX_OUTPUT_CHARS} more chars]`
    : s;
}

/**
 * Searches `target/release/<name>` (this repo's Cargo workspace build
 * output) starting at `startDir` and walking up to `maxUp` ancestor
 * directories — handles the server being launched with a CWD anywhere
 * inside the repo (or pointed at a data-root several levels under it).
 */
function findInCargoTarget(
  name: string,
  startDir: string,
  maxUp = 8,
): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i <= maxUp; i++) {
    const exeName = process.platform === 'win32' ? `${name}.exe` : name;
    const candidate = path.join(dir, 'target', 'release', exeName);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolves a tool binary: `override` wins outright; else search
 * `target/release/` upward from each of `searchRoots`; else the bare `name`
 * (PATH lookup, performed by `spawn` itself — no error here even if it's
 * not actually on PATH, that surfaces as an ENOENT from `run()`).
 */
export function resolveBinary(
  name: string,
  override: string | undefined,
  searchRoots: string[],
): string {
  if (override) return override;
  for (const root of searchRoots) {
    const found = findInCargoTarget(name, root);
    if (found) return found;
  }
  return name;
}

/**
 * Runs `bin args…`, capturing stdout/stderr, with a hard timeout (the
 * process is killed and `timedOut: true` on expiry — execution tools are
 * inherently long-running-adjacent, e.g. a full `stt-build`, so callers
 * should pass a generous `timeoutMs` for that one).
 *
 * Pass `options.signal` to bind the run to an `AbortSignal` (e.g. the MCP
 * client's request-cancellation): an already-aborted signal short-circuits
 * without spawning, and a mid-run abort SIGKILLs the child so a cancelled
 * request can't leave an orphaned `stt-build`/`stt-optimize` burning CPU.
 * `aborted` is independent of `timedOut`.
 */
export function run(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  const start = Date.now();
  return new Promise((resolve) => {
    // Already-cancelled request: don't even spawn — resolve immediately.
    if (signal?.aborted) {
      resolve({
        bin,
        args,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: true,
        durationMs: Date.now() - start,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      cleanup();
      resolve({
        bin,
        args,
        exitCode: null,
        signal: null,
        stdout: truncate(stdout),
        stderr: truncate(
          `${stderr}\n${err instanceof Error ? err.message : String(err)}`,
        ),
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code, signal) => {
      cleanup();
      resolve({
        bin,
        args,
        exitCode: code,
        signal,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
        aborted,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Parses stdout as JSON; returns `undefined` (rather than throwing) when it isn't — callers fall back to raw text. */
export function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
