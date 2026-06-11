import React, { useEffect, useRef, useState } from "react";

let nextId = 0;

/**
 * Renders a ```mermaid fence as an SVG diagram. Mermaid is ~450 kB+, so it is
 * ONLY ever loaded via dynamic import here — one docs page uses it
 * (architecture/system-overview), and only that page pays. A parse/render
 * failure degrades to the plain code block instead of breaking the page.
 */
const Mermaid: React.FC<{ code: string }> = ({ code }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`stt-mermaid-${nextId++}`);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        });
        // render() needs a unique id per call — it creates (and can leak on
        // error) DOM scratch nodes keyed by it.
        const { svg } = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(svg);
      } catch (err) {
        console.warn("[docs] mermaid render failed:", err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre
        className="code-block px-4 py-3 my-4 overflow-x-auto rounded-md"
        style={{
          background: "var(--surface-sunken)",
          border: "1px solid var(--hairline)",
        }}
      >
        {code}
      </pre>
    );
  }
  if (!svg) {
    return (
      <div
        className="my-4 rounded-md px-4 py-8 text-center text-xs"
        style={{
          background: "var(--surface-sunken)",
          color: "var(--ink-400)",
        }}
      >
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="my-4 overflow-x-auto [&_svg]:max-w-full [&_svg]:h-auto"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
};

export default Mermaid;
