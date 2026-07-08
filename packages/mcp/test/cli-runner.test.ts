import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveBinary, run, tryParseJson } from '../src/cli-runner';

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined for invalid JSON rather than throwing', () => {
    expect(tryParseJson('not json')).toBeUndefined();
  });
});

describe('run', () => {
  it('captures stdout/stderr and exit code for a successful process', async () => {
    const result = await run(process.execPath, ['-e', 'console.log("hi"); console.error("oops")']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(result.stderr.trim()).toBe('oops');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit code', async () => {
    const result = await run(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('kills a hung process after the timeout and marks timedOut', async () => {
    const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
  }, 10_000);

  it('surfaces a spawn error (unknown binary) without throwing', async () => {
    const result = await run('definitely-not-a-real-binary-xyz', []);
    expect(result.exitCode).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.aborted).toBe(false);
  });

  it('short-circuits an already-aborted signal without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    // Never spawned → returns effectively instantly.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('SIGKILLs a long-running child when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const promise = run(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
      signal: controller.signal,
    });
    // Abort on the next tick, once the child has spawned.
    setTimeout(() => controller.abort(), 20);
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    // Killed promptly rather than waiting out the 10s child.
    expect(Date.now() - start).toBeLessThan(5000);
  }, 10_000);
});

describe('resolveBinary', () => {
  it('an explicit override always wins', () => {
    expect(resolveBinary('stt-optimize', '/custom/path/stt-optimize', ['/some/root'])).toBe(
      '/custom/path/stt-optimize',
    );
  });

  it('finds target/release/<name> by walking up from a search root', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'stt-mcp-cli-'));
    try {
      const nested = path.join(tmp, 'examples', 'showcase', 'public', 'data');
      await mkdir(nested, { recursive: true });
      const releaseDir = path.join(tmp, 'target', 'release');
      await mkdir(releaseDir, { recursive: true });
      const binPath = path.join(releaseDir, 'stt-optimize');
      await writeFile(binPath, '#!/bin/sh\necho fake\n', { mode: 0o755 });

      expect(resolveBinary('stt-optimize', undefined, [nested])).toBe(binPath);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to the bare name when nothing is found', () => {
    expect(resolveBinary('stt-optimize', undefined, ['/definitely/not/a/real/root'])).toBe('stt-optimize');
  });
});
