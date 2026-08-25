import { describe, expect, it, vi } from 'vitest';
import worker, { isClientOnlyRoute } from '../worker.js';

function assetsEnvironment() {
  return {
    ASSETS: {
      fetch: vi.fn(
        async () =>
          new Response('<!doctype html><title>poopdeck.gl</title>', {
            headers: { etag: 'test-shell' },
          }),
      ),
    },
  };
}

function navigation(pathname: string, method = 'GET'): Request {
  return new Request(`https://poopdeck.gl${pathname}`, {
    method,
    headers: { accept: 'text/html' },
  });
}

describe('showcase Worker routing', () => {
  it('recognizes only explicit client-only route shapes', () => {
    expect(isClientOnlyRoute('/demo/earthquakes')).toBe(true);
    expect(isClientOnlyRoute('/maplibre/earthquakes/')).toBe(true);
    expect(isClientOnlyRoute('/cesium/earthquakes')).toBe(true);
    expect(isClientOnlyRoute('/drive')).toBe(true);
    expect(isClientOnlyRoute('/drive/nuscenes-0103')).toBe(true);
    expect(isClientOnlyRoute('/story/drifters')).toBe(true);
    expect(isClientOnlyRoute('/not-a-route')).toBe(false);
    expect(isClientOnlyRoute('/demo/id/extra')).toBe(false);
  });

  it('serves the SPA shell with 200 only for explicit client routes', async () => {
    const response = await worker.fetch(
      navigation('/demo/earthquakes'),
      assetsEnvironment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns a real 404 shell for unknown navigations', async () => {
    const response = await worker.fetch(
      navigation('/definitely-not-a-page'),
      assetsEnvironment(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('does not disguise missing machine-readable assets as HTML', async () => {
    const response = await worker.fetch(
      new Request('https://poopdeck.gl/missing.schema.json', {
        headers: { accept: 'application/json' },
      }),
      assetsEnvironment(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('Not found');
  });

  it('rejects mutation methods instead of returning the SPA shell', async () => {
    const response = await worker.fetch(
      navigation('/demo/earthquakes', 'POST'),
      assetsEnvironment(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
