/**
 * Variant-tab markdown contract.
 *
 * The tab syntax is an HTML-comment fence around bold label lines, chosen so
 * the SAME file reads correctly on GitHub and in `llms-full.txt` (where the
 * comments vanish and the labels remain). These tests pin both halves: the
 * parser's behavior, and the guarantee that a page with no markers is byte-for-
 * byte the single markdown segment it always was.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import Markdown from '../src/docs/Markdown.tsx';
import { parseDocSegments, tabGroupKey } from '../src/docs/tabs';
import { extractHeadings } from '../src/docs/headings';

const quickstart = readFileSync(
  fileURLToPath(new URL('../../../docs/intro/quickstart.md', import.meta.url)),
  'utf8',
);

describe('parseDocSegments', () => {
  it('leaves markdown without markers as one segment', () => {
    const raw = '# Title\n\nSome prose.\n\n```ts\nconst a = 1;\n```\n';
    expect(parseDocSegments(raw)).toEqual([{ kind: 'markdown', text: raw }]);
  });

  it('splits a tab group out of the surrounding prose', () => {
    const raw = [
      'Before.',
      '',
      '<!--tabs-->',
      '',
      '**React**',
      '',
      '```tsx',
      'const a = 1;',
      '```',
      '',
      '**Vanilla JS**',
      '',
      '```js',
      'const b = 2;',
      '```',
      '',
      '<!--/tabs-->',
      '',
      'After.',
    ].join('\n');

    const segments = parseDocSegments(raw);
    expect(segments.map((s) => s.kind)).toEqual([
      'markdown',
      'tabs',
      'markdown',
    ]);
    expect(segments[0]).toMatchObject({
      text: expect.stringContaining('Before.'),
    });
    const tabs = segments[1].kind === 'tabs' ? segments[1].tabs : [];
    expect(tabs.map((t) => t.label)).toEqual(['React', 'Vanilla JS']);
    expect(tabs[0].text).toBe('```tsx\nconst a = 1;\n```');
    expect(tabs[1].text).toBe('```js\nconst b = 2;\n```');
    expect(segments[2]).toMatchObject({
      text: expect.stringContaining('After.'),
    });
  });

  it('ignores markers and bold lines inside a code fence', () => {
    const raw = [
      '<!--tabs-->',
      '**React**',
      '```md',
      '<!--tabs-->',
      '**Not a tab**',
      '<!--/tabs-->',
      '```',
      '<!--/tabs-->',
    ].join('\n');

    const segments = parseDocSegments(raw);
    expect(segments).toHaveLength(1);
    const tabs = segments[0].kind === 'tabs' ? segments[0].tabs : [];
    expect(tabs.map((t) => t.label)).toEqual(['React']);
    expect(tabs[0].text).toContain('**Not a tab**');
  });

  it('keeps prose that precedes the first label outside the group', () => {
    const raw = [
      '<!--tabs-->',
      'stray prose',
      '**A**',
      'body',
      '<!--/tabs-->',
    ].join('\n');
    const segments = parseDocSegments(raw);
    expect(segments.map((s) => s.kind)).toEqual(['markdown', 'tabs']);
    expect(segments[0]).toMatchObject({ text: 'stray prose' });
  });

  it('recovers from an unterminated group instead of dropping the rest', () => {
    const raw = ['<!--tabs-->', '**A**', 'body a', '**B**', 'body b'].join(
      '\n',
    );
    const segments = parseDocSegments(raw);
    expect(segments).toHaveLength(1);
    const tabs = segments[0].kind === 'tabs' ? segments[0].tabs : [];
    expect(tabs.map((t) => t.text)).toEqual(['body a', 'body b']);
  });

  it('drops a group with no labelled tabs rather than rendering an empty control', () => {
    const raw = ['<!--tabs-->', '<!--/tabs-->', '', 'after'].join('\n');
    expect(parseDocSegments(raw).map((s) => s.kind)).toEqual(['markdown']);
  });

  it('keys a group by its label set, so like groups share the selection', () => {
    expect(
      tabGroupKey([
        { label: 'React', text: '' },
        { label: 'Vanilla JS', text: '' },
      ]),
    ).toBe('React|Vanilla JS');
  });
});

describe('the quickstart page', () => {
  const segments = parseDocSegments(quickstart);
  const groups = segments.flatMap((s) => (s.kind === 'tabs' ? [s.tabs] : []));

  it('parses into balanced React / Vanilla JS groups', () => {
    expect(groups.length).toBeGreaterThan(0);
    for (const tabs of groups) {
      expect(tabs.map((t) => t.label)).toEqual(['React', 'Vanilla JS']);
      for (const tab of tabs) expect(tab.text.length).toBeGreaterThan(0);
    }
  });

  it('leaves no unbalanced tab markers behind', () => {
    const opens = quickstart.match(/^<!--\s*tabs\s*-->$/gm)?.length ?? 0;
    const closes = quickstart.match(/^<!--\s*\/tabs\s*-->$/gm)?.length ?? 0;
    expect(opens).toBe(closes);
    expect(opens).toBe(groups.length);
  });

  it('puts no headings inside a tab body — the TOC would list hidden anchors', () => {
    const offenders = groups.flatMap((tabs) =>
      tabs
        .filter((tab) => extractHeadings(tab.text).length > 0)
        .map((tab) => tab.label),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps every in-page anchor it links to', () => {
    const ids = new Set(extractHeadings(quickstart).map((h) => h.id));
    const dangling = [...quickstart.matchAll(/\]\(#([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((anchor) => !ids.has(anchor));
    expect(dangling).toEqual([]);
  });
});

describe('rendering the quickstart through the docs markdown pipeline', () => {
  // Server render == the prerender pass the docs pages actually ship through,
  // so this also pins that the tab store's `getServerSnapshot` works: no
  // localStorage on the server, first tab selected, no hydration mismatch.
  const html = renderToString(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(Markdown, {
        raw: quickstart,
        currentFile: 'intro/quickstart.md',
      }),
    ),
  );

  it('renders a tablist with both variants offered', () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('>React</button>');
    expect(html).toContain('>Vanilla JS</button>');
  });

  it('renders only the selected variant body', () => {
    // React-only and vanilla-only identifiers, one per tab family.
    expect(html).toContain('usePlayback');
    expect(html).not.toContain('SttPlayer');
  });

  it('still renders the surrounding prose and heading anchors', () => {
    expect(html).toContain('id="1-install"');
    expect(html).toContain('id="4-use-your-own-data"');
    expect(html).toContain('tiles.poopdeck.gl');
  });
});
