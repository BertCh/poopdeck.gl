---
'@poopdeck.gl/core': minor
---

Removed: `emitGLSL300` (and Cesium's `timeFilterAlphaGlsl` wrapper)

`@poopdeck.gl/core/shader-codegen` no longer exports `emitGLSL300`, and
`@poopdeck.gl/cesium` no longer exports `timeFilterAlphaGlsl`. Neither was in
any render path: no shipped shader was ever generated from the expression AST,
and the Cesium GPU-`Appearance` path the wrapper anticipated was never wired —
every Cesium layer CPU-filters through `timeFilterAlpha`. `emitGLSL100` had
already gone the same way, for the same reason.

**Not removed, and the reason the module still exists:** `ALPHA_EXPR` and
`evalExpr`. They are the **second oracle** — a branchless, independently
derived statement of the same alpha math that each backend's hand-written
shader is pinned to by a conformance test. Conformance compares the alpha
_value_, not the shader _text_, so the emitter was never what made it work.

`docs/spec/render-spec.json` now declares an empty `emitters` list, and a
contract test asserts both removed names stay absent — so an emitter cannot
quietly return without something that compiles its output.

**If you were calling it** (unlikely — the Cesium package is unpublished and
core's emitter had no other caller): the op-set is frozen and tiny
(`uniform`, `attr`, `const`, `add`, `sub`, `mul`, `div`, `min`, `max`, `step`,
`clamp01`, `select`), so walking `ALPHA_EXPR[mode]` to a string is a short
function. Emit `select` as a ternary to keep the divide-by-zero fade guard
lazy.
