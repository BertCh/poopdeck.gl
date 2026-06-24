/**
 * Google Photorealistic 3D Tiles overlay for the AV cockpit's deck.gl surface.
 *
 * Wraps deck.gl's `Tile3DLayer` (from `@deck.gl/geo-layers`, which bundles the
 * loaders.gl `Tiles3DLoader`) pointed at Google's OGC-3D-Tiles photoreal city
 * mesh (`tile.googleapis.com`). The layer renders in geographic coordinates, so
 * it composites directly into the cockpit's Mercator `MapView` alongside the STT
 * LIDAR / ego / object layers.
 *
 * ── Vertical alignment ─────────────────────────────────────────────────────
 * Google's mesh is referenced to TRUE WGS84 ellipsoidal height (downtown
 * Pittsburgh ground ≈ +210 m), but the AV cloud is placed in a LOCAL ground
 * frame at `z ≈ 0` (the extractor's `local_to_lonlat` keeps x/y as ground metres
 * and passes the source's near-zero `z` through). Rendered as-is, the whole city
 * floats a few hundred metres ABOVE the cloud, out of the street-level frame.
 *
 * The fix lives in {@link GroundedTile3DLayer}: each tile renders via a sub-layer
 * in `METER_OFFSETS` from its own `cartographicOrigin = [lng, lat, height]`, so
 * subtracting a constant ground height from that origin drops the ENTIRE mesh
 * onto `z ≈ 0` while preserving every building's relative height — no per-tile
 * matrix math, and it composes with the tiles' own model matrices. The ground
 * height is auto-detected from the tiles nearest the scene anchor (see
 * {@link buildGoogle3DTilesLayer}), so it generalises to any city with no magic
 * numbers.
 *
 * The Google Maps Platform key rides the `X-GOOG-API-KEY` request header;
 * loaders.gl re-applies it to every child tile request. Google's Terms of
 * Service REQUIRE the per-tile data attribution to be shown on screen; we union
 * the visible tiles' `copyright` strings each traversal and hand them to the
 * cockpit chrome via {@link Google3DTilesOptions.onAttribution}.
 */
import { Tile3DLayer } from "@deck.gl/geo-layers";

/** Google Photorealistic 3D Tiles root tileset (global photoreal mesh). */
const GOOGLE_3D_TILES_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";

/** Horizontal radius (m) around the anchor whose tiles seed the ground estimate. */
const GROUND_SAMPLE_RADIUS_M = 400;

/**
 * `Tile3DLayer` that lowers the whole tileset by `elevationOffset` metres so the
 * photoreal mesh (WGS84-ellipsoidal heights) sits on local ground-frame data at
 * `z ≈ 0`. Uniform for every tile, so relative building heights are preserved.
 *
 * The shift is applied at the `Tileset3D.modelMatrix` (a translation down the
 * geodetic "up" vector at the scene anchor), NOT at render time. That matters:
 * the tileset roots EVERY tile's `computedTransform` at `modelMatrix`, and that
 * transform drives both the bounding-volume culling / screen-space-error LOD AND
 * the rendered `cartographicOrigin`. Shifting only the render (e.g. the sub-layer's
 * coordinate origin) leaves the LOD traversal believing the tiles are at their true
 * height — so the camera looks ~200 m "underground" to it and the wrong detail level
 * streams in. Driving `modelMatrix` keeps LOD and render consistent. We update it
 * live (the slider trim changes `elevationOffset`) and force a re-traversal so the
 * new root transform propagates immediately.
 *
 * Extend through an `any` cast: we override `updateState` and reach private members
 * (`state.tileset3d`, `_updateTileset`); the cast relaxes the compile-time checks.
 */
const GroundedTile3DLayer = class extends (Tile3DLayer as any) {
  updateState(params: any) {
    super.updateState(params);
    const tileset = this.state && this.state.tileset3d;
    const off = this.props.elevationOffset || 0;
    if (tileset && this._appliedGroundOffset !== off) {
      this._appliedGroundOffset = off;
      const [lng, lat] = this.props.anchor || [0, 0];
      // Geodetic surface normal (unit "up") in ECEF at the anchor.
      const la = (lat * Math.PI) / 180;
      const lo = (lng * Math.PI) / 180;
      const cl = Math.cos(la);
      const up = [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
      // Reuse the existing modelMatrix's class (a math.gl Matrix4) so the showcase
      // needs no direct @math.gl/core dependency.
      const Mat = tileset.modelMatrix.constructor;
      tileset.modelMatrix = new Mat().translate([
        up[0] * -off,
        up[1] * -off,
        up[2] * -off,
      ]);
      // Re-traverse so the new root transform recomputes LOD + tile positions.
      const viewports = this.state.activeViewports;
      if (viewports && Object.keys(viewports).length) {
        this._updateTileset(viewports);
      }
    }
  }
};
(GroundedTile3DLayer as any).layerName = "GroundedTile3DLayer";
(GroundedTile3DLayer as any).defaultProps = {
  ...(Tile3DLayer as any).defaultProps,
  elevationOffset: 0,
};

export interface Google3DTilesOptions {
  /** Google Maps Platform API key (`VITE_GOOGLE_MAPS_API_KEY`). */
  apiKey: string;
  /**
   * Stable per-scene id suffix (the dataset id). The tileset reloads + re-anchors
   * when it changes, so switching scenes re-detects the new city's ground height.
   */
  sceneId: string;
  /** Scene anchor `[lng, lat]` (degrees) — seeds the ground-height auto-detect. */
  anchor: [number, number];
  /**
   * Metres to lower the mesh so it sits on the `z ≈ 0` cloud (0 = unshifted).
   * Pass the value reported by {@link onGroundHeight}.
   */
  elevationOffset?: number;
  /**
   * Fires each traversal with the detected local ground ellipsoidal height (m)
   * from the tiles nearest the anchor. The caller freezes the first reading and
   * feeds it back as {@link elevationOffset}.
   */
  onGroundHeight?: (height: number) => void;
  /**
   * Receives the comma-joined union of the visible tiles' data attribution
   * strings (Google's ToS requires displaying it). Empty until tiles resolve.
   */
  onAttribution?: (credits: string) => void;
  /**
   * Layer opacity (0–1). Below 1 dims/ghosts the photoreal mesh so the LIDAR
   * cloud reads more clearly against it (useful when the animated cloud drifts
   * slightly out of sync with the static buildings). @default 1
   */
  opacity?: number;
}

/**
 * Build the Google Photorealistic 3D Tiles layer. Returns a single
 * `GroundedTile3DLayer`; callers prepend it to the deck layer list so it draws
 * UNDER the (translucent) LIDAR cloud while still writing depth (opaque buildings
 * occlude returns behind them).
 */
export function buildGoogle3DTilesLayer(opts: Google3DTilesOptions) {
  const [anchorLng, anchorLat] = opts.anchor;
  const cosLat = Math.cos((anchorLat * Math.PI) / 180);
  // `elevationOffset` / `anchor` are subclass-only props (not in Tile3DLayerProps),
  // and the `any`-extended class has a loose constructor, so the class + literal
  // are cast — the known props below still match Tile3DLayer's shape.
  return new (GroundedTile3DLayer as any)({
    id: `google-3d-tiles-${opts.sceneId}`,
    data: GOOGLE_3D_TILES_URL,
    // The key rides the fetch header; loaders.gl propagates it to child tiles.
    loadOptions: {
      fetch: { headers: { "X-GOOG-API-KEY": opts.apiKey } },
    },
    // Not a pick target — clicks belong to the object boxes (see AvDeck).
    pickable: false,
    // Below 1 ghosts the photoreal mesh so the LIDAR cloud reads against it.
    opacity: opts.opacity ?? 1,
    // Drive the tileset modelMatrix shift (see GroundedTile3DLayer.updateState).
    elevationOffset: opts.elevationOffset ?? 0,
    anchor: opts.anchor,
    onTilesetLoad: (tileset: any) => {
      tileset.options.onTraversalComplete = (selectedTiles: any[]) => {
        // One pass over the visible tiles for BOTH the required Google data
        // attribution (union of `copyright`) and the local ground estimate
        // (lowest tile origin within GROUND_SAMPLE_RADIUS_M of the anchor —
        // street/park tiles sit at true ground, towers' origins ride higher).
        const credits = new Set<string>();
        let groundHeight: number | null = null;
        for (const tile of selectedTiles) {
          const content = tile?.content;
          const copyright: string = content?.gltf?.asset?.copyright ?? "";
          for (const part of copyright.split(";")) {
            const c = part.trim();
            if (c) credits.add(c);
          }
          const co = content?.cartographicOrigin;
          if (Array.isArray(co) && Number.isFinite(co[2])) {
            const dxM = (co[0] - anchorLng) * 111320 * cosLat;
            const dyM = (co[1] - anchorLat) * 111320;
            if (Math.hypot(dxM, dyM) <= GROUND_SAMPLE_RADIUS_M) {
              groundHeight =
                groundHeight === null ? co[2] : Math.min(groundHeight, co[2]);
            }
          }
        }
        opts.onAttribution?.(Array.from(credits).join(", "));
        if (groundHeight !== null) opts.onGroundHeight?.(groundHeight);
        return selectedTiles;
      };
    },
  } as any);
}
