import type { ReactNode } from 'react';
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  type LinksFunction,
  type MetaFunction,
} from 'react-router';
import './index.css';

/**
 * Root route — the document shell for the whole app (framework mode replaces
 * the hand-written index.html + main.tsx). `<Meta>`/`<Links>` inject the
 * per-route head; `<Scripts>` boots the client bundle; hydration targets the
 * whole `document` (see entry.client.tsx).
 */

export const links: LinksFunction = () => [
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  // Editorial type for the data stories (Fraunces display + Newsreader body
  // serif). `display=swap` so first paint never blocks on the fonts.
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700;9..144,900&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap',
  },
];

export const meta: MetaFunction = () => [
  { title: 'poopdeck.gl — navigation & observation' },
  {
    name: 'description',
    content:
      'poopdeck.gl — time-aware deck.gl layers and a tile format for streaming animated geospatial data. Built for things that move: ships, drifters, cars, and anything with a trace.',
  },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, viewport-fit=cover"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Shown before hydration for any route not statically prerendered — this is
 * the markup baked into the generic SPA fallback shell that Cloudflare serves
 * for the client-only fullscreen viewers and unknown paths.
 */
export function HydrateFallback() {
  return (
    <div
      className="w-full h-full flex items-center justify-center text-sm"
      style={{ background: 'var(--page-bg)', color: 'var(--ink-400)' }}
    >
      Loading…
    </div>
  );
}

/**
 * Top-level error boundary (ports the former ErrorBoundary class from
 * main.tsx): any uncaught render error, thrown route Response, or 404 renders
 * a legible failure card with a reload escape hatch instead of a blank screen.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'The page hit an unexpected error and could not render.';

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: '#0a0d12' }}
    >
      <div className="max-w-md text-center">
        <h1 className="font-display text-lg font-semibold text-slate-100 mb-2">
          Something went wrong
        </h1>
        <p className="text-sm text-slate-400 mb-1">
          The page hit an unexpected error and could not render.
        </p>
        <p className="text-xs font-mono text-slate-500 mb-5 break-words">
          {message}
        </p>
        {import.meta.env.DEV && error instanceof Error && error.stack && (
          <pre className="text-left text-[10px] leading-snug font-mono text-slate-600 mb-5 max-h-48 overflow-auto whitespace-pre-wrap">
            {error.stack}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded text-xs font-medium text-slate-200 border border-white/20 transition-colors hover:bg-white/10"
          >
            Reload
          </button>
          {/* Plain anchor, not <Link>: the boundary may sit above the router,
              so navigate with a full document load. */}
          <a
            href="/"
            className="px-3 py-1.5 rounded text-xs font-medium text-slate-400 transition-colors hover:text-cyan-300"
          >
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
