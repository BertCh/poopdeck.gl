import "./prism-setup";
import "prismjs/components/prism-bash";
import React, { useState } from "react";
import { Highlight, type PrismTheme } from "prism-react-renderer";

/**
 * Fenced-code renderer for the docs, themed from the site's design tokens —
 * paper-sunken background, accent-cyan keywords — instead of a stock dark
 * theme that would fight the editorial page.
 */
const docsTheme: PrismTheme = {
  plain: {
    color: "var(--ink-700)",
    backgroundColor: "transparent",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "var(--ink-400)", fontStyle: "italic" },
    },
    { types: ["punctuation", "operator"], style: { color: "var(--ink-500)" } },
    {
      types: ["keyword", "atrule", "selector", "important"],
      style: { color: "#0a7790", fontWeight: "600" },
    },
    {
      types: ["string", "char", "attr-value", "inserted"],
      style: { color: "#207036" },
    },
    {
      types: ["number", "boolean", "constant", "symbol"],
      style: { color: "#9a4a00" },
    },
    {
      types: ["function", "class-name", "tag", "builtin"],
      style: { color: "#7a3e9d" },
    },
    {
      types: ["variable", "property", "attr-name", "parameter"],
      style: { color: "#15414e" },
    },
    { types: ["deleted"], style: { color: "#b3261e" } },
  ],
};

/** Map fence languages to grammars prism actually has loaded. */
function normalizeLanguage(lang: string): string {
  switch (lang) {
    case "jsonc":
      return "json";
    case "sh":
    case "shell":
    case "console":
      return "bash";
    default:
      return lang;
  }
}

const CodeBlock: React.FC<{ code: string; language: string }> = ({
  code,
  language,
}) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      className="group/code relative rounded-md my-4 overflow-hidden"
      style={{
        background: "var(--surface-sunken)",
        border: "1px solid var(--hairline)",
      }}
    >
      <button
        type="button"
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase opacity-0 group-hover/code:opacity-100 transition-opacity"
        style={{
          background: copied ? "var(--accent)" : "var(--surface)",
          color: copied ? "#fff" : "var(--ink-500)",
          border: "1px solid var(--hairline)",
        }}
        aria-label="Copy code"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <Highlight
        code={code.replace(/\n$/, "")}
        language={normalizeLanguage(language)}
        theme={docsTheme}
      >
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="code-block px-4 py-3 overflow-x-auto">
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
};

export default CodeBlock;
