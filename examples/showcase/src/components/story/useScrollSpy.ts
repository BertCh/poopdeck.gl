import { useEffect, useState } from 'react';

/**
 * Scroll-spy for the data story. Observes the elements whose ids are given and
 * returns whichever one is nearest the vertical center of the viewport — the
 * signal the page uses to (a) re-aim the globe and (b) decide whether an
 * opaque interlude is currently covering the globe stage.
 */
export function useScrollSpy(ids: string[]): string | null {
  const key = ids.join('|');
  const [active, setActive] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const els = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el != null);
    if (!els.length) return;

    const visible = new Set<string>();
    const recompute = () => {
      const mid = window.innerHeight / 2;
      let best: string | null = null;
      let bestDist = Infinity;
      visible.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const center = r.top + r.height / 2;
        const d = Math.abs(center - mid);
        if (d < bestDist) {
          bestDist = d;
          best = id;
        }
      });
      if (best) setActive(best);
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        recompute();
      },
      // Only elements crossing the central 20% band count as candidates.
      { rootMargin: '-40% 0px -40% 0px', threshold: [0, 0.5, 1] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return active;
}
