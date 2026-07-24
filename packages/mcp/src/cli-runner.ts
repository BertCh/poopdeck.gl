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

/**
 * A stream capture that stops GROWING at {@link MAX_OUTPUT_CHARS} instead of
 * buffering everything and truncating at the end. The cap has to apply while
 * reading, not on the way out: a child that streams gigabytes to stdout (a
 * `stt-build` in a log-spewing failure loop, or a mistargeted binary) would
 * otherwise sit in this process's heap in full before anyone trimmed it. The
 * overflow is still counted exactly, so the truncation note stays honest.
 */
class CappedOutput {
  private text = '';
  private dropped = 0;

  push(chunk: string): void {
    const room = MAX_OUTPUT_CHARS - this.text.length;
    if (room > 0) {
      this.text += chunk.length <= room ? chunk : chunk.slice(0, room);
    }
    if (chunk.length > room) this.dropped += chunk.length - Math.max(room, 0);
  }

  toString(): string {
    return this.dropped > 0
      ? `${this.text}\n… [truncated, ${this.dropped} more chars]`
      : this.text;
  }
}

/**
 * Searches `target/release/<name>` (this repo's Cargo workspace build
 * output) starting at `startDir` and walking up to `maxUp` ancestor
 * directories — handles the server being launched with a CWD anywhere
 * inside the repo (or pointed at a data-root several levels under it).
 *
 * `tools/<name>/target/release/<name>` is probed at each level too: an
 * INTERNAL binary that is not one of the published crates lives outside the
 * root Cargo workspace (with its own `[workspace]`, so its dep tree can't
 * force an MSRV on the published crates), and therefore has its own `target/`.
 * `stt-generate` is the one that moved out; without this probe it resolves to
 * a bare PATH lookup and a repo checkout that built it never finds it.
 */
function findInCargoTarget(
  name: string,
  startDir: string,
  maxUp = 8,
): string | undefined {
  let dir = path.resolve(startDir);
  const exeName = process.platform === 'win32' ? `${name}.exe` : name;
  for (let i = 0; i <= maxUp; i++) {
    for (const candidate of [
      path.join(dir, 'target', 'release', exeName),
      path.join(dir, 'tools', name, 'target', 'release', exeName),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
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

    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
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
      stdout.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk) => {
      stderr.push(chunk.toString('utf8'));
    });
    child.on('error', (err) => {
      cleanup();
      resolve({
        bin,
        args,
        exitCode: null,
        signal: null,
        stdout: stdout.toString(),
        // The spawn failure (typically ENOENT for a binary that isn't on PATH)
        // is appended AFTER the cap, not folded into it — it's the one line the
        // caller actually needs, and it used to be the first thing dropped when
        // a chatty child had already filled the buffer.
        stderr: `${stderr.toString()}\n${err instanceof Error ? err.message : String(err)}`,
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
        stdout: stdout.toString(),
        stderr: stderr.toString(),
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
