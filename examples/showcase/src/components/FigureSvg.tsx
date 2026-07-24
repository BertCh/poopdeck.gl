import React from 'react';

/**
 * An INFORMATIVE inline SVG figure: `<svg role="img" aria-label="…">`.
 *
 * The role is what collapses a diagram into ONE node with ONE accessible name.
 * Without it a screen reader walks the `<text>` labels inside the drawing and
 * reads coordinates and axis stubs as prose, which is how these figures used to
 * sound. Every caller passes `aria-label`; nothing else here is decoration.
 *
 * It exists as a component, rather than the role being repeated at each of the
 * ~23 figures, because `jsx-a11y/prefer-tag-over-role` (an ERROR in
 * .oxlintrc.json) maps `role="img"` → `<img>` and has no case for inline SVG,
 * where `<img>` cannot carry live, prop-driven geometry. Declaring the role in
 * exactly one place keeps that rule enforcing for the violations it is right
 * about — a `<div role="button">` — instead of being downgraded repo-wide to
 * let 23 correct diagrams through.
 *
 * Callers import it with the EXPLICIT `.tsx` extension: the showcase's
 * `vitest.config.ts` pins `resolve.extensions` to `['.ts', '.mjs', '.js',
 * '.json']`, so an extensionless import of a `.tsx` module fails to resolve in
 * every suite that loads the importing component.
 */
const FigureSvg: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see above: <img> cannot host an inline, prop-driven SVG diagram.
  <svg role="img" {...props} />
);

export default FigureSvg;
