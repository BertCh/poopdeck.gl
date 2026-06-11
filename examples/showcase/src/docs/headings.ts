/**
 * Extracts h2/h3 headings from raw markdown for the on-this-page TOC.
 * Slugified with github-slugger — the SAME algorithm rehype-slug uses on the
 * rendered headings (including duplicate dedupe → `#usage-1`), so TOC anchors
 * always match the DOM ids. The slugger is reset per call for that parity.
 */
import GithubSlugger from "github-slugger";

export interface TocHeading {
  level: 2 | 3;
  text: string;
  id: string;
}

/** Strip inline markdown (code spans, links, emphasis) for display text. */
function plainText(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .trim();
}

export function extractHeadings(raw: string): TocHeading[] {
  const slugger = new GithubSlugger();
  const headings: TocHeading[] = [];
  let inFence = false;
  let fenceMarker = "";
  for (const line of raw.split("\n")) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (fence[1][0] === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const text = plainText(m[2]);
    // Slug from the RAW heading text (rehype-slug slugs the rendered text,
    // which equals the plain text after inline markdown is rendered).
    headings.push({
      level: m[1].length as 2 | 3,
      text,
      id: slugger.slug(text),
    });
  }
  return headings;
}
