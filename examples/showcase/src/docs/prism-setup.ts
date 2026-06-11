/**
 * prism-react-renderer v2 vendors a fixed language set that does NOT include
 * bash — the most common fence language in our docs. The documented escape
 * hatch is exposing its Prism instance globally and importing the missing
 * grammar from prismjs. This module must be imported BEFORE any
 * `prismjs/components/*` side-effect import (ESM evaluation order makes that
 * hold for importers that list it first).
 */
import { Prism } from "prism-react-renderer";

(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;
