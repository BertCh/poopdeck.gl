/**
 * End-to-end tool exercise over an in-process MCP transport
 * (`InMemoryTransport.createLinkedPair()`), driving `createSttMcpServer()`
 * with a real `Client` exactly like a real MCP host would — no stdio
 * subprocess needed for the unit-test suite (the throwaway stdio exercise
 * against the compiled `dist/bin.js` is a separate, manual verification
 * step; see the package README).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, chmod } from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSttMcpServer } from '../src/server';
import type { SttMcpConfig } from '../src/config';
import {
  makeManifestJson,
  writeFixtureDataRoot,
  cleanupDataRoot,
} from './fixtures';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await cleanupDataRoot(roots.pop()!);
});

async function fixtureRoot(datasets: Record<string, unknown>): Promise<string> {
  const root = await writeFixtureDataRoot(datasets);
  roots.push(root);
  return root;
}

function baseConfig(
  dataRoot: string,
  overrides: Partial<SttMcpConfig> = {},
): SttMcpConfig {
  return {
    dataRoot,
    // A non-existent docs root by default: the doc tools/resource degrade
    // gracefully (empty corpus) so tests not about docs are unaffected. Doc
    // tests pass an explicit fixture docsRoot via overrides.
    docsRoot: path.join(dataRoot, '__no_docs__'),
    allowCli: false,
    transport: 'stdio',
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  };
}

async function connectedClient(
  config: SttMcpConfig,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createSttMcpServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const block = (result.content as any[]).find((c) => c.type === 'text');
  return block.text as string;
}

describe('createSttMcpServer — discovery tools', () => {
  it('registers exactly the discovery + analysis + interactive tools when allowCli is off', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'dataset_report',
          'describe_dataset',
          'diff_datasets',
          'get_doc',
          'list_datasets',
          'play_pause',
          'recommend_build',
          'search_docs',
          'set_time',
          'view_map',
        ].sort(),
      );
    } finally {
      await close();
    }
  });

  it('exposes datasets as stt://datasets/<name> resources', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
      'nyc-taxi': makeManifestJson({ metadata: { name: 'nyc-taxi' } }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri).sort();
      expect(uris).toEqual([
        'stt://datasets/earthquakes',
        'stt://datasets/nyc-taxi',
      ]);

      const read = await client.readResource({
        uri: 'stt://datasets/earthquakes',
      });
      const doc = JSON.parse((read.contents[0] as any).text);
      expect(doc.name).toBe('earthquakes');
      expect(read.contents[0].mimeType).toBe('application/json');
    } finally {
      await close();
    }
  });

  it('recommend_build / diff_datasets return an --allow-cli hint when the CLI is off', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const rec = JSON.parse(
        firstText(
          await client.callTool({
            name: 'recommend_build',
            arguments: { input: '/x.parquet' },
          }),
        ),
      );
      expect(rec.cliEnabled).toBe(false);
      expect(rec.message).toMatch(/--allow-cli/);

      const diff = JSON.parse(
        firstText(
          await client.callTool({
            name: 'diff_datasets',
            arguments: { before: 'a', after: 'b' },
          }),
        ),
      );
      expect(diff.cliEnabled).toBe(false);
      expect(diff.message).toMatch(/--allow-cli/);
    } finally {
      await close();
    }
  });

  it('additionally registers build_dataset + validate_dataset when allowCli is on', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true }),
    );
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('build_dataset');
      expect(names).toContain('validate_dataset');
      expect(names).toContain('generate_dataset');
    } finally {
      await close();
    }
  });

  it('list_datasets returns the scanned catalog', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
      'nyc-od-quadbin': makeManifestJson({
        metadata: {
          summary_tier: { scheme: 'quadbin', min_zoom: 8, max_zoom: 15 },
        },
      }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'list_datasets',
        arguments: {},
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.count).toBe(2);
      expect(parsed.datasets.map((d: any) => d.name).sort()).toEqual([
        'earthquakes',
        'nyc-od-quadbin',
      ]);
      const quadbin = parsed.datasets.find(
        (d: any) => d.name === 'nyc-od-quadbin',
      );
      expect(quadbin.hasSummaryTier).toBe(true);
      expect(quadbin.summaryScheme).toBe('quadbin');
    } finally {
      await close();
    }
  });

  it('list_datasets honors the search filter', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson(),
      'nyc-taxi': makeManifestJson(),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'list_datasets',
        arguments: { search: 'taxi' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.datasets.map((d: any) => d.name)).toEqual(['nyc-taxi']);
    } finally {
      await close();
    }
  });

  it('describe_dataset returns the full manifest for a known dataset', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'describe_dataset',
        arguments: { name: 'earthquakes' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.name).toBe('earthquakes');
      expect(parsed.packCount).toBe(2);
      expect(parsed.capabilities).toEqual(['coord-quant']);
    } finally {
      await close();
    }
  });

  it('describe_dataset reports an error (not a thrown exception) for an unknown name', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'describe_dataset',
        arguments: { name: 'nope' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/nope/);
    } finally {
      await close();
    }
  });

  it('dataset_report without --allow-cli returns a manifest-only fallback', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'dataset_report',
        arguments: { name: 'earthquakes' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.cliEnabled).toBe(false);
      expect(parsed.manifestSummary.name).toBe('earthquakes');
      expect(parsed.message).toMatch(/--allow-cli/);
    } finally {
      await close();
    }
  });

  it('dataset_report reports a distinct "not found" error for an unknown name (not the --allow-cli hint)', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'dataset_report',
        arguments: { name: 'nope' },
      });
      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toMatch(/nope/);
      expect(text).toMatch(/not found/i);
      expect(text).not.toMatch(/--allow-cli/);
    } finally {
      await close();
    }
  });
});

describe('createSttMcpServer — interactive tools', () => {
  it('view_map composes a @deck.gl/json spec pointed at the manifest, with a text + resource block', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'view_map',
        arguments: { datasets: 'earthquakes', time: 500 },
      });
      const textBlock = (result.content as any[]).find(
        (c) => c.type === 'text',
      );
      const spec = JSON.parse(textBlock.text);
      expect(spec.layers).toHaveLength(1);
      expect(spec.layers[0]['@@type']).toBe('AnimatedPointLayer');
      expect(spec.layers[0].data).toBe(
        path.join(root, 'earthquakes', 'manifest.json'),
      );
      expect(spec.layers[0].currentTime).toBe(500);

      const resourceBlock = (result.content as any[]).find(
        (c) => c.type === 'resource',
      );
      expect(resourceBlock?.resource?.mimeType).toBe('text/html');
      expect(resourceBlock?.resource?.text).toContain('<!doctype html>');
    } finally {
      await close();
    }
  });

  it('view_map accepts a list of dataset names and a layer override', async () => {
    const root = await fixtureRoot({
      a: makeManifestJson({ metadata: { name: 'a' } }),
      b: makeManifestJson({ metadata: { name: 'b' } }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'view_map',
        arguments: { datasets: ['a', 'b'], layer: 'AnimatedArcLayer' },
      });
      const spec = JSON.parse(
        (result.content as any[]).find((c) => c.type === 'text').text,
      );
      expect(spec.layers).toHaveLength(2);
      expect(
        spec.layers.every((l: any) => l['@@type'] === 'AnimatedArcLayer'),
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it('view_map respects --public-base-url for the manifest URL', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const { client, close } = await connectedClient(
      baseConfig(root, { publicBaseUrl: 'https://tiles.example.com' }),
    );
    try {
      const result = await client.callTool({
        name: 'view_map',
        arguments: { datasets: 'earthquakes' },
      });
      const spec = JSON.parse(
        (result.content as any[]).find((c) => c.type === 'text').text,
      );
      expect(spec.layers[0].data).toBe(
        'https://tiles.example.com/earthquakes/manifest.json',
      );
    } finally {
      await close();
    }
  });

  it('view_map rejects an unknown top-level key (strict schema) instead of silently dropping it', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const result = await client.callTool({
        name: 'view_map',
        // `viewstate` is a typo for `viewState` — must error, not be dropped.
        arguments: { datasets: 'earthquakes', viewstate: { zoom: 3 } },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/viewstate/i);
    } finally {
      await close();
    }
  });

  it('set_time and play_pause return structured intents, not renderer side effects', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const { client, close } = await connectedClient(baseConfig(root));
    try {
      const setTime = JSON.parse(
        firstText(
          await client.callTool({ name: 'set_time', arguments: { time: 42 } }),
        ),
      );
      expect(setTime).toEqual({ intent: 'set_time', time: 42 });

      const playPause = JSON.parse(
        firstText(
          await client.callTool({
            name: 'play_pause',
            arguments: { playing: true, speed: 2 },
          }),
        ),
      );
      expect(playPause).toEqual({
        intent: 'play_pause',
        playing: true,
        speed: 2,
      });
    } finally {
      await close();
    }
  });
});

describe('createSttMcpServer — execution tools (--allow-cli)', () => {
  /** A tiny fake `stt-optimize`/`stt-validate` executable so these tests never depend on real cargo binaries. */
  async function writeFakeCli(
    dir: string,
    name: string,
    script: string,
  ): Promise<string> {
    const binPath = path.join(dir, name);
    await writeFile(binPath, `#!/usr/bin/env node\n${script}\n`, 'utf8');
    await chmod(binPath, 0o755);
    return binPath;
  }

  it('dataset_report shells out to stt-optimize inspect + doctor and returns parsed JSON', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize',
      `const sub = process.argv[2];
       console.log(JSON.stringify({ subcommand: sub, ok: true }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'dataset_report',
        arguments: { name: 'earthquakes' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.cliEnabled).toBe(true);
      expect(parsed.inspect).toEqual({ subcommand: 'inspect', ok: true });
      expect(parsed.doctor).toEqual({ subcommand: 'doctor', ok: true });
    } finally {
      await close();
    }
  });

  it('validate_dataset shells out to stt-validate and returns the parsed report', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const sttValidateBin = await writeFakeCli(
      root,
      'fake-stt-validate',
      `console.log(JSON.stringify({ errors: [], warnings: [] }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttValidateBin }),
    );
    try {
      const result = await client.callTool({
        name: 'validate_dataset',
        arguments: { name: 'earthquakes' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.exitCode).toBe(0);
      expect(parsed.report).toEqual({ errors: [], warnings: [] });
    } finally {
      await close();
    }
  });

  it('build_dataset shells out to stt-build and reads back the resulting manifest', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const outputDir = path.join(root, 'built-output');
    const sttBuildBin = await writeFakeCli(
      root,
      'fake-stt-build',
      `const fs = require('node:fs');
       const args = process.argv.slice(2);
       const output = args[args.indexOf('--output') + 1];
       fs.mkdirSync(output, { recursive: true });
       fs.writeFileSync(output + '/manifest.json', JSON.stringify(${JSON.stringify(
         makeManifestJson({ metadata: { name: 'built' } }),
       )}));
       console.log('build ok');`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttBuildBin }),
    );
    try {
      const result = await client.callTool({
        name: 'build_dataset',
        arguments: { input: '/fake/input.parquet', output: outputDir },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.exitCode).toBe(0);
      expect(parsed.manifestSummary.path).toBe(outputDir);
      expect(parsed.manifestSummary.formatVersion).toBe(2);
    } finally {
      await close();
    }
  });

  it('recommend_build parses the recipe and renders a canonical stt-build command', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-recommend',
      `const input = process.argv[process.argv.indexOf('--input') + 1];
       console.log(JSON.stringify({ input, time_field: 'timestamp', min_zoom: 2, max_zoom: 9, temporal_bucket_ms: 3600000, confidence: 88, explanations: ['dense localized cluster'] }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'recommend_build',
        arguments: { input: '/data/quakes.parquet', output: 'quakes-out' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.cliEnabled).toBe(true);
      expect(parsed.recommendation.max_zoom).toBe(9);
      expect(parsed.recommendation.confidence).toBe(88);
      expect(parsed.suggestedCommand).toContain('--min-zoom 2 --max-zoom 9');
      expect(parsed.suggestedCommand).toContain('--temporal-bucket 1h');
      expect(parsed.suggestedCommand).toContain('--style-hints');
    } finally {
      await close();
    }
  });

  it('diff_datasets shells out to stt-optimize diff and returns the parsed report', async () => {
    const root = await fixtureRoot({
      a: makeManifestJson({ metadata: { name: 'a' } }),
      b: makeManifestJson({ metadata: { name: 'b' } }),
    });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-diff',
      `console.log(JSON.stringify({ before_name: 'a', after_name: 'b', compressed_bytes: { before: 100, after: 80, delta: -20, pct: -20 } }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'diff_datasets',
        arguments: { before: 'a', after: 'b' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.exitCode).toBe(0);
      expect(parsed.report.compressed_bytes.delta).toBe(-20);
    } finally {
      await close();
    }
  });

  it('diff_datasets augments the report with requested names, physical bytes, a logical-bytes note, and the sample default', async () => {
    const root = await fixtureRoot({
      a: makeManifestJson({ metadata: { name: 'a' } }),
      b: makeManifestJson({ metadata: { name: 'b' } }),
    });
    // Echo the received argv so we can prove --sample 256 was passed by default.
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-diff-argv',
      `console.log(JSON.stringify({ before_name: 'archive-meta-a', after_name: 'archive-meta-b', argv: process.argv.slice(2) }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'diff_datasets',
        arguments: { before: 'a', after: 'b' },
      });
      const parsed = JSON.parse(firstText(result));
      // Caller's own names/dirs, distinct from the Rust archive metadata names.
      expect(parsed.requestedBefore.name).toBe('a');
      expect(parsed.requestedAfter.name).toBe('b');
      expect(parsed.requestedBefore.dir).toBe(path.join(root, 'a'));
      // Best-effort physical at-rest bytes (directory.length + sum(packs)) from the fixtures.
      expect(parsed.beforePhysicalBytes).toBe(4096 + 1_000_000 + 500_000);
      expect(parsed.afterPhysicalBytes).toBe(4096 + 1_000_000 + 500_000);
      expect(parsed.note).toMatch(/logical/i);
      // Sample defaulted to 256 (sample omitted, exact not set).
      expect(parsed.sampledDefault).toBe(256);
      expect(parsed.report.argv).toContain('--sample');
      expect(parsed.report.argv).toContain('256');
    } finally {
      await close();
    }
  });

  it('diff_datasets with exact:true omits --sample and the sample-default marker', async () => {
    const root = await fixtureRoot({
      a: makeManifestJson({ metadata: { name: 'a' } }),
      b: makeManifestJson({ metadata: { name: 'b' } }),
    });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-diff-exact',
      `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'diff_datasets',
        arguments: { before: 'a', after: 'b', exact: true },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.report.argv).not.toContain('--sample');
      expect(parsed.sampledDefault).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('dataset_report defaults the decode sample to 256 and marks sampledDefault', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-sample',
      `const argv = process.argv.slice(2);
       console.log(JSON.stringify({ subcommand: argv[0], argv }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'dataset_report',
        arguments: { name: 'earthquakes' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.sampledDefault).toBe(256);
      expect(parsed.inspect.argv).toContain('--sample');
      expect(parsed.inspect.argv).toContain('256');
    } finally {
      await close();
    }
  });

  it('validate_dataset returns isError with the full payload when the CLI exits nonzero', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const sttValidateBin = await writeFakeCli(
      root,
      'fake-stt-validate-fail',
      `process.stderr.write('validation blew up'); process.exit(3);`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttValidateBin }),
    );
    try {
      const result = await client.callTool({
        name: 'validate_dataset',
        arguments: { name: 'earthquakes' },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(firstText(result));
      // Still carries the full structured payload, not just an error string.
      expect(parsed.exitCode).toBe(3);
      expect(parsed.stderr).toMatch(/blew up/);
    } finally {
      await close();
    }
  });

  it('validate_dataset rejects name and path supplied together (mutually exclusive)', async () => {
    const root = await fixtureRoot({
      earthquakes: makeManifestJson({ metadata: { name: 'earthquakes' } }),
    });
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true }),
    );
    try {
      const result = await client.callTool({
        name: 'validate_dataset',
        arguments: { name: 'earthquakes', path: '/some/other/archive' },
      });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toMatch(/mutually exclusive/i);
    } finally {
      await close();
    }
  });

  it('recommend_build also returns machine-readable buildDatasetArgs for the build_dataset tool', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const sttOptimizeBin = await writeFakeCli(
      root,
      'fake-stt-optimize-recommend-args',
      `const input = process.argv[process.argv.indexOf('--input') + 1];
       console.log(JSON.stringify({ input, time_field: 'timestamp', min_zoom: 2, max_zoom: 9, temporal_bucket_ms: 3600000, confidence: 88, explanations: [] }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttOptimizeBin }),
    );
    try {
      const result = await client.callTool({
        name: 'recommend_build',
        arguments: {
          input: '/data/quakes.parquet',
          output: 'quakes-out',
          timeField: 'ts',
        },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.buildDatasetArgs).toEqual({
        input: '/data/quakes.parquet',
        output: 'quakes-out',
        timeField: 'ts',
        minZoom: 2,
        maxZoom: 9,
        temporalBucket: '1h',
        styleHints: true,
      });
    } finally {
      await close();
    }
  });

  it('generate_dataset shells out to stt-generate with --output and forwards extraArgs', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const outputPath = path.join(root, 'built', 'earthquakes.stt');
    const sttGenerateBin = await writeFakeCli(
      root,
      'fake-stt-generate',
      `const fs = require('node:fs');
       const args = process.argv.slice(2);
       const output = args[args.indexOf('--output') + 1];
       fs.mkdirSync(output, { recursive: true });
       fs.writeFileSync(output + '/manifest.json', JSON.stringify(${JSON.stringify(
         makeManifestJson({ metadata: { name: 'earthquakes' } }),
       )}));
       console.log(JSON.stringify({ argv: args }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttGenerateBin }),
    );
    try {
      const result = await client.callTool({
        name: 'generate_dataset',
        arguments: {
          dataset: 'earthquakes',
          output: outputPath,
          extraArgs: ['--limit', '500'],
        },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.exitCode).toBe(0);
      expect(parsed.args).toEqual([
        'earthquakes',
        '--output',
        outputPath,
        '--limit',
        '500',
      ]);
      // Single-dataset run reads the resulting manifest back.
      expect(parsed.manifestSummary.formatVersion).toBe(2);
    } finally {
      await close();
    }
  });

  it('generate_dataset maps `all` to --output-dir (not --output)', async () => {
    const root = await fixtureRoot({ earthquakes: makeManifestJson() });
    const sttGenerateBin = await writeFakeCli(
      root,
      'fake-stt-generate-all',
      `console.log(JSON.stringify({ argv: process.argv.slice(2) }));`,
    );
    const { client, close } = await connectedClient(
      baseConfig(root, { allowCli: true, sttGenerateBin }),
    );
    try {
      const result = await client.callTool({
        name: 'generate_dataset',
        arguments: { dataset: 'all', output: '/tmp/showcase-data' },
      });
      const parsed = JSON.parse(firstText(result));
      expect(parsed.args).toEqual([
        'all',
        '--output-dir',
        '/tmp/showcase-data',
      ]);
      // `all` writes many datasets, so no single manifest is read back.
      expect(parsed.manifestSummary).toBeUndefined();
    } finally {
      await close();
    }
  });
});
