---
'@poopdeck.gl/three': major
---

**BREAKING (`@poopdeck.gl/three`): `STTPointCloudLayer` is renamed to `STTPointLayer`, and the `STTPointCloudLayer` name now belongs to a different layer.**

The class that renders the `point` layer kind — flat, unlit billboards — was
named `STTPointCloudLayer`, while `@poopdeck.gl/maplibre` and
`@poopdeck.gl/cesium` both call that same kind `STTPointLayer`. That violated
the one-spelling-per-kind rule stated in this package's own barrel header, and
it left the canonical name occupied when the backend gained a real `pointCloud`
kind (phong-lit 3D points with optional normals — deck's
`AnimatedPointCloudLayer`).

So:

- `STTPointCloudLayer` → **`STTPointLayer`** (unchanged behaviour; the billboard
  point layer, moved from `layers/point-cloud-layer.ts` to `layers/point-layer.ts`).
- `STTPointCloudLayerOptions` → **`STTPointLayerOptions`**.
- **`STTPointCloudLayer` now names the new phong-lit `pointCloud` layer** — a
  different renderer with a different options type.

There is deliberately **no deprecated alias**, because the old name is now taken
by different behaviour: an alias would silently swap one renderer for another at
runtime instead of failing at compile time. Callers must rename the import.
The r3f wrapper `<STTPointCloudLayer>` is renamed the same way; the pre-0.5
`SttPointCloudLayer` alias continues to resolve to the billboard point layer and
is annotated accordingly.
