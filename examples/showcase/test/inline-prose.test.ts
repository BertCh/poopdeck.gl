import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';

import InlineProse from '../src/components/InlineProse.tsx';

/**
 * The demo pages' editorial prose is authored in inline markdown. Before
 * `InlineProse` the detail page rendered it as `<p>{text}</p>`, so 47 code
 * spans shipped to production as literal backticks on 46 public pages. These
 * cases pin the splitter that fixed it — and, importantly, pin what it must
 * NOT do (swallow a link inside a code span, or emit raw markup).
 */
function render(text: string): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: '/demos/x' },
      React.createElement(InlineProse, { text }),
    ),
  );
}

describe('InlineProse', () => {
  it('renders inline code as a <code> chip, not backticks', () => {
    const html = render('Rebuild with `--blob-ordering time-major` first.');
    expect(html).toContain('<code class="inline-code">--blob-ordering');
    expect(html).not.toContain('`');
  });

  it('routes an absolute link through react-router (client navigation)', () => {
    const html = render('Open [the cockpit](/drive/nuscenes-0103).');
    expect(html).toContain('href="/drive/nuscenes-0103"');
    // A router <Link> is a plain <a> in static markup; what matters is that it
    // is NOT flagged as an external tab-opener.
    expect(html).not.toContain('target="_blank"');
  });

  it('opens an external link in a new tab with rel=noopener', () => {
    const html = render('See [deck.gl](https://deck.gl).');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders bold and keeps the surrounding text intact', () => {
    const html = render('One **clock** for every layer.');
    expect(html).toContain('<strong');
    expect(html).toContain('clock');
    expect(html).toContain('for every layer.');
    expect(html).not.toContain('**');
  });

  it('leaves an unmatched backtick as literal text (no swallowed paragraph)', () => {
    const html = render('A lone ` tick and then some prose.');
    expect(html).toContain('A lone ` tick and then some prose.');
  });

  it('does not let a code span and a link consume each other', () => {
    const html = render('`--flag` then [a demo](/demo/ship-traffic) after.');
    expect(html).toContain('<code class="inline-code">--flag</code>');
    expect(html).toContain('href="/demo/ship-traffic"');
  });

  it('escapes HTML in the source prose rather than injecting it', () => {
    const html = render('An <em>emphasis</em> attempt.');
    expect(html).not.toContain('<em>');
    expect(html).toContain('&lt;em&gt;');
  });

  it('is re-entrant — the module-level /g regex cannot leak lastIndex', () => {
    const text = 'First `a` then `b`.';
    expect(render(text)).toBe(render(text));
  });
});
