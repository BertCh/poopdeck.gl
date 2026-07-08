import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseCliArgs, HelpRequested } from '../src/config';

describe('parseCliArgs', () => {
  it('defaults to stdio transport, allowCli off, and a resolved data-root', () => {
    const config = parseCliArgs([]);
    expect(config.transport).toBe('stdio');
    expect(config.allowCli).toBe(false);
    expect(path.isAbsolute(config.dataRoot)).toBe(true);
  });

  it('parses --data-root, --allow-cli, --transport, --host, --port', () => {
    const config = parseCliArgs([
      '--data-root',
      '/tmp/data',
      '--allow-cli',
      '--transport',
      'http',
      '--host',
      '0.0.0.0',
      '--port',
      '4000',
    ]);
    expect(config.dataRoot).toBe('/tmp/data');
    expect(config.allowCli).toBe(true);
    expect(config.transport).toBe('http');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
  });

  it('defaults docsRoot to an absolute path and resolves --docs-root', () => {
    expect(path.isAbsolute(parseCliArgs([]).docsRoot)).toBe(true);
    const config = parseCliArgs(['--docs-root', '/tmp/docs']);
    expect(config.docsRoot).toBe('/tmp/docs');
  });

  it('honors $STT_DOCS_ROOT as the docsRoot fallback', () => {
    const prev = process.env.STT_DOCS_ROOT;
    process.env.STT_DOCS_ROOT = '/env/docs';
    try {
      expect(parseCliArgs([]).docsRoot).toBe('/env/docs');
      // An explicit flag still wins over the env fallback.
      expect(parseCliArgs(['--docs-root', '/flag/docs']).docsRoot).toBe(
        '/flag/docs',
      );
    } finally {
      if (prev === undefined) delete process.env.STT_DOCS_ROOT;
      else process.env.STT_DOCS_ROOT = prev;
    }
  });

  it('parses binary overrides and --public-base-url', () => {
    const config = parseCliArgs([
      '--stt-optimize-bin',
      '/usr/local/bin/stt-optimize',
      '--stt-build-bin',
      '/usr/local/bin/stt-build',
      '--stt-validate-bin',
      '/usr/local/bin/stt-validate',
      '--stt-generate-bin',
      '/usr/local/bin/stt-generate',
      '--public-base-url',
      'https://tiles.example.com',
    ]);
    expect(config.sttOptimizeBin).toBe('/usr/local/bin/stt-optimize');
    expect(config.sttBuildBin).toBe('/usr/local/bin/stt-build');
    expect(config.sttValidateBin).toBe('/usr/local/bin/stt-validate');
    expect(config.sttGenerateBin).toBe('/usr/local/bin/stt-generate');
    expect(config.publicBaseUrl).toBe('https://tiles.example.com');
  });

  it('throws HelpRequested for -h/--help', () => {
    expect(() => parseCliArgs(['--help'])).toThrow(HelpRequested);
    expect(() => parseCliArgs(['-h'])).toThrow(HelpRequested);
  });

  it('rejects an invalid --transport value', () => {
    expect(() => parseCliArgs(['--transport', 'carrier-pigeon'])).toThrow(
      /stdio.*http/,
    );
  });

  it('rejects an unrecognized flag', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(/unrecognized argument/);
  });

  it('defaults the DNS-rebinding allow-lists to the bind host/port loopback aliases', () => {
    const config = parseCliArgs([]);
    expect(config.allowedHosts).toEqual(['127.0.0.1:3900', 'localhost:3900']);
    expect(config.allowedOrigins).toEqual([
      'http://127.0.0.1:3900',
      'http://localhost:3900',
    ]);
  });

  it('derives the default allow-lists from a custom --host/--port', () => {
    const config = parseCliArgs(['--host', '0.0.0.0', '--port', '4000']);
    expect(config.allowedHosts).toEqual([
      '0.0.0.0:4000',
      '127.0.0.1:4000',
      'localhost:4000',
    ]);
    expect(config.allowedOrigins).toEqual([
      'http://0.0.0.0:4000',
      'http://127.0.0.1:4000',
      'http://localhost:4000',
    ]);
  });

  it('adds repeatable --allowed-host/--allowed-origin flags to the defaults', () => {
    const config = parseCliArgs([
      '--allowed-host',
      'stt.internal:3900',
      '--allowed-host',
      'stt.example.com',
      '--allowed-origin',
      'https://app.example.com',
      '--allowed-origin',
      'https://studio.example.com',
    ]);
    expect(config.allowedHosts).toEqual([
      '127.0.0.1:3900',
      'localhost:3900',
      'stt.internal:3900',
      'stt.example.com',
    ]);
    expect(config.allowedOrigins).toEqual([
      'http://127.0.0.1:3900',
      'http://localhost:3900',
      'https://app.example.com',
      'https://studio.example.com',
    ]);
  });

  it('de-duplicates a user flag that repeats a default allow-list entry', () => {
    const config = parseCliArgs(['--allowed-host', 'localhost:3900']);
    expect(config.allowedHosts).toEqual(['127.0.0.1:3900', 'localhost:3900']);
  });
});
