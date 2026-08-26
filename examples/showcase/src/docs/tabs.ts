/**
 * Variant tabs for docs markdown ("React" vs "Vanilla JS", "npm" vs "pnpm", …).
 *
 * The docs corpus is plain markdown that has to stay readable in three places:
 * rendered here, browsed on GitHub, and concatenated into `llms-full.txt`. So
 * the syntax is an HTML-comment fence — invisible everywhere markdown is
 * rendered — around bold label lines, which ARE visible everywhere else:
 *
 *     <!--tabs-->
 *
 *     **React**
 *
 *     ```tsx
 *     …
 *     ```
 *
 *     **Vanilla JS**
 *
 *     ```js
 *     …
 *     ```
 *
 *     <!--/tabs-->
 *
 * A reader on GitHub sees both variants under bold headings; a reader on the
 * site sees a segmented control and one variant at a time. Nothing is hidden
 * from the plain-text surfaces, which is why this is a comment fence and not a
 * remark directive plugin.
 *
 * Label lines are matched at fence depth 0 only, so a `**bold**` line inside a
 * code block can never split a tab.
 */

export interface DocTab {
  label: string;
  /** Markdown body of this tab, label line stripped. */
  text: string;
}

export type DocSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'tabs'; tabs: DocTab[] };

const TABS_OPEN = /^<!--\s*tabs\s*-->\s*$/;
const TABS_CLOSE = /^<!--\s*\/tabs\s*-->\s*$/;
/** A whole line that is nothing but bold text — the tab label. */
const TAB_LABEL = /^\*\*(.+?)\*\*\s*$/;
const FENCE = /^\s*(```+|~~~+)/;

/** Stable key for a tab group: two groups offering the same labels share state. */
export function tabGroupKey(tabs: readonly DocTab[]): string {
  return tabs.map((t) => t.label).join('|');
}

/**
 * Split raw markdown into plain-markdown runs and tab groups.
 *
 * Forgiving by design: an unterminated `<!--tabs-->` still yields its tabs, and
 * a group with no label lines degrades to a plain markdown segment. A docs page
 * must never fail to render over a typo in a comment marker.
 */
export function parseDocSegments(raw: string): DocSegment[] {
  const segments: DocSegment[] = [];
  const lines = raw.split('\n');

  let buffer: string[] = [];
  let tabs: DocTab[] | null = null;
  let fence = '';

  const flushBuffer = () => {
    const text = buffer.join('\n');
    buffer = [];
    if (!text.trim()) return;
    if (tabs && tabs.length > 0) {
      tabs[tabs.length - 1].text = text.trim();
    } else {
      segments.push({ kind: 'markdown', text });
    }
  };

  const closeTabs = () => {
    flushBuffer();
    if (tabs && tabs.length > 0) segments.push({ kind: 'tabs', tabs });
    tabs = null;
  };

  for (const line of lines) {
    const opener = FENCE.exec(line);
    if (opener) {
      const marker = opener[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = '';
      buffer.push(line);
      continue;
    }
    if (fence) {
      buffer.push(line);
      continue;
    }

    if (!tabs && TABS_OPEN.test(line)) {
      flushBuffer();
      tabs = [];
      continue;
    }
    if (tabs && TABS_CLOSE.test(line)) {
      closeTabs();
      continue;
    }
    if (tabs) {
      const label = TAB_LABEL.exec(line);
      if (label) {
        flushBuffer();
        tabs.push({ label: label[1].trim(), text: '' });
        continue;
      }
    }
    buffer.push(line);
  }

  if (tabs) closeTabs();
  else flushBuffer();

  return segments.filter(
    (s) => s.kind !== 'tabs' || s.tabs.some((t) => t.text.length > 0),
  );
}
