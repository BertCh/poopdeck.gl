import React from 'react';
import { Link } from 'react-router';

/**
 * Minimal inline-markdown renderer for the editorial prose in
 * `src/content/demoMeta.ts` (`about[]`, `buildNote`).
 *
 * The bug it prevents: those strings are authored in markdown — 47 code spans
 * across 19 demos — but the detail page rendered them as `<p>{p}</p>`, so every
 * public demo page shipped literal backticks ("the `--blob-ordering` walk").
 * Only INLINE constructs are supported, deliberately: each string is one
 * paragraph, so blocks (headings, lists, fences) can't occur, and routing this
 * through `src/docs/Markdown.tsx` would pull react-markdown + remark-gfm +
 * prism + mermaid into the statically prerendered detail-page bundle that is
 * otherwise kept free of them.
 *
 * Supported: `code`, [label](target) and **bold**. A target starting with "/"
 * becomes a react-router <Link> (client navigation, so "/drive/nuscenes-0103"
 * reads as the real cockpit link it is); anything else opens in a new tab.
 * Unmatched backticks/brackets fall through as plain text.
 */

// One alternation, scanned left to right, so a link label can't swallow a code
// span and vice versa. Groups: 1 = code, 2/3 = link label/target, 4 = bold.
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

export function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  // A module-level regex with /g carries lastIndex between calls — reset it.
  INLINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [, code, label, target, bold] = m;
    if (code !== undefined) {
      out.push(
        <code key={key++} className="inline-code">
          {code}
        </code>,
      );
    } else if (label !== undefined && target !== undefined) {
      out.push(
        target.startsWith('/') ? (
          <Link key={key++} to={target} style={{ color: 'var(--accent)' }}>
            {label}
          </Link>
        ) : (
          <a
            key={key++}
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            {label}
          </a>
        ),
      );
    } else if (bold !== undefined) {
      out.push(
        <strong key={key++} style={{ color: 'var(--ink-900)' }}>
          {bold}
        </strong>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The same rendering as a component, for use directly inside JSX. */
const InlineProse: React.FC<{ text: string }> = ({ text }) => (
  <>{renderInline(text)}</>
);

export default InlineProse;
