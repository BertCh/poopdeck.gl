import React, { useCallback, useId, useRef, useSyncExternalStore } from 'react';
import { tabGroupKey, type DocTab } from './tabs';

/**
 * The segmented control for a docs tab group (see `tabs.ts` for the markdown
 * syntax) plus the tiny store behind it.
 *
 * The choice is SHARED and PERSISTED: pick "React" once and every tab group on
 * every docs page that offers "React" switches with it, across reloads. That is
 * the whole point of the control — a reader who works in React should never
 * have to re-answer the question. State is keyed by the group's label set
 * ({@link tabGroupKey}), so a React/Vanilla group and an npm/pnpm group are
 * independent while two React/Vanilla groups are one.
 *
 * Backed by `useSyncExternalStore` rather than context + effect: the docs pages
 * are PRERENDERED, and an effect-based read of localStorage would paint the
 * default variant for one frame before correcting itself on every navigation.
 * `getServerSnapshot` returns the empty selection so prerendered HTML and the
 * hydration pass agree; React re-reads the client snapshot right after.
 */

const STORAGE_KEY = 'stt-docs-tab-variant';

type Selection = Readonly<Record<string, string>>;

const EMPTY: Selection = Object.freeze({});

let selection: Selection | null = null;
const listeners = new Set<() => void>();

function read(): Selection {
  if (selection) return selection;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    selection =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.freeze({ ...(parsed as Record<string, string>) })
        : EMPTY;
  } catch {
    // Private mode / disabled storage: in-memory selection still works.
    selection = EMPTY;
  }
  return selection;
}

function select(key: string, label: string): void {
  selection = Object.freeze({ ...read(), [key]: label });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Non-fatal — the choice just doesn't survive a reload.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active tab label for a group, falling back to its first tab. */
function useActiveLabel(key: string, tabs: readonly DocTab[]): string {
  const stored = useSyncExternalStore(
    subscribe,
    () => read()[key],
    () => undefined,
  );
  return stored !== undefined && tabs.some((t) => t.label === stored)
    ? stored
    : tabs[0].label;
}

const DocTabs: React.FC<{
  tabs: DocTab[];
  /** Renders one tab body — the same markdown renderer used for the page. */
  children: (tab: DocTab) => React.ReactNode;
}> = ({ tabs, children }) => {
  const key = tabGroupKey(tabs);
  const active = useActiveLabel(key, tabs);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.label === active),
  );
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // Roving arrow-key traversal, the ARIA tablist convention.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!delta) return;
      e.preventDefault();
      const next = (activeIndex + delta + tabs.length) % tabs.length;
      select(key, tabs[next].label);
      listRef.current
        ?.querySelectorAll<HTMLButtonElement>('button')
        [next]?.focus();
    },
    [activeIndex, key, tabs],
  );

  return (
    <div className="my-5">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Code variant"
        // Roving tabindex lives on the buttons; the container is only
        // programmatically focusable so the role has a focus target.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="not-prose flex gap-1 p-0.5 rounded-md w-fit"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--hairline)',
        }}
      >
        {tabs.map((tab, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={tab.label}
              type="button"
              role="tab"
              id={`${baseId}-tab-${i}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${i}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(key, tab.label)}
              className="px-3 py-1 rounded text-xs font-medium transition-colors"
              style={{
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                color: isActive ? 'var(--accent)' : 'var(--ink-500)',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeIndex}`}
        aria-labelledby={`${baseId}-tab-${activeIndex}`}
      >
        {children(tabs[activeIndex])}
      </div>
    </div>
  );
};

export default DocTabs;
