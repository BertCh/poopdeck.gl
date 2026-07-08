/// <reference types="vite/client" />

// prismjs language grammars are untyped side-effect modules (they register
// themselves on the global Prism). Declared so the dynamic import in
// docs/prism-setup.ts type-checks under strict mode.
declare module "prismjs/components/*";
