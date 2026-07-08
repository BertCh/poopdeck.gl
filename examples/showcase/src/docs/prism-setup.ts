/**
 * prism-react-renderer v2 vendors a fixed language set that does NOT include
 * bash — the most common fence language in our docs. The documented escape
 * hatch is exposing its Prism instance globally and importing the missing
 * grammar from prismjs.
 *
 * The bash grammar loads on the CLIENT only. prism-bash.js registers itself
 * against the global Prism as a side effect; during the Node prerender we skip
 * it because (a) a static import gets hoisted above the global assignment in
 * the SSR bundle ("Prism is not defined"), and (b) deferring it with top-level
 * await breaks the server bundle's CJS/ESM format detection (it also contains
 * require()). Code still renders server-side (as plain text) and highlights
 * after hydration — CodeBlock re-renders when `bashGrammarReady` resolves.
 */
import { Prism } from 'prism-react-renderer';

(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

let bashReady = false;

export function isBashReady(): boolean {
  return bashReady;
}

export const bashGrammarReady: Promise<void> = import.meta.env.SSR
  ? Promise.resolve()
  : import('prismjs/components/prism-bash').then(() => {
      bashReady = true;
    });
