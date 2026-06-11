import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { Link } from "react-router-dom";
import { rewriteHref } from "./links";
import CodeBlock from "./CodeBlock";
import Mermaid from "./Mermaid";

/**
 * The docs markdown renderer: GFM tables, slugged headings with hover
 * anchors, prism-highlighted fences (mermaid fences become diagrams), and
 * GitHub-style relative links rewritten into router links / GitHub blob URLs
 * via `rewriteHref` (resolution is relative to `currentFile`).
 */
const Markdown: React.FC<{
  raw: string;
  /** docs-relative path of this page, e.g. "api/animated-point-layer.md". */
  currentFile: string;
  /** Scroll container for same-page #fragment links. */
  scrollContainer?: () => HTMLElement | null;
}> = ({ raw, currentFile, scrollContainer }) => {
  const scrollToHash = (hash: string) => {
    const el = document.getElementById(decodeURIComponent(hash));
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSlug]}
      components={{
        a({ href, children }) {
          if (!href) return <span>{children}</span>;
          const link = rewriteHref(href, currentFile);
          if (link.kind === "internal") {
            return <Link to={link.to}>{children}</Link>;
          }
          if (link.kind === "hash") {
            return (
              <a
                href={`#${link.hash}`}
                onClick={(e) => {
                  // The window never scrolls (body overflow:hidden) — scroll
                  // the docs container instead of relying on default behavior.
                  e.preventDefault();
                  history.replaceState(null, "", `#${link.hash}`);
                  scrollToHash(link.hash);
                  void scrollContainer; // container handled by scrollIntoView
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
        // Fences: CodeBlock / Mermaid take over the <pre>; inline code keeps
        // the default styling from the prose theme.
        pre({ children }) {
          return <>{children}</>;
        },
        code(props) {
          const { className, children } = props;
          const match = /language-([\w-]+)/.exec(className || "");
          const value = String(children);
          if (!match) {
            // Inline code (block code always carries a language-* class via
            // the fence, and our docs never use bare fences — verified).
            // Bare fences still land here with a newline; render them as a
            // plain block.
            if (value.includes("\n")) {
              return <CodeBlock code={value} language="text" />;
            }
            return <code className={className}>{children}</code>;
          }
          if (match[1] === "mermaid") return <Mermaid code={value} />;
          return <CodeBlock code={value} language={match[1]} />;
        },
        h2: makeHeading("h2"),
        h3: makeHeading("h3"),
        h4: makeHeading("h4"),
        table({ children }) {
          return (
            <div className="overflow-x-auto">
              <table>{children}</table>
            </div>
          );
        },
      }}
    >
      {raw}
    </ReactMarkdown>
  );
};

function makeHeading(Tag: "h2" | "h3" | "h4") {
  const Heading: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
    id,
    children,
    ...rest
  }) => (
    <Tag id={id} className="group/h scroll-mt-4" {...rest}>
      {children}
      {id && (
        <a
          href={`#${id}`}
          className="ml-2 no-underline opacity-0 group-hover/h:opacity-60 transition-opacity"
          style={{ color: "var(--accent)" }}
          aria-label="Link to this section"
          onClick={(e) => {
            e.preventDefault();
            history.replaceState(null, "", `#${id}`);
            document
              .getElementById(id)
              ?.scrollIntoView({ block: "start", behavior: "smooth" });
          }}
        >
          #
        </a>
      )}
    </Tag>
  );
  Heading.displayName = `DocsHeading(${Tag})`;
  return Heading;
}

export default Markdown;
