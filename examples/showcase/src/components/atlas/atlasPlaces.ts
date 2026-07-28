/**
 * Named density peaks — what the atlas has instead of cluster hulls.
 *
 * §15.7 of `docs/roadmap/neural-atlas-2026-07.md` measured that this dataset
 * has no cluster structure to outline. Leiden communities have an 80%-radius of
 * ~3° on a 32° plane; a clumpier embedding made that worse because UMAP's
 * islands cut across the partition; HDBSCAN on the embedding itself finds two
 * clusters; and when hulls were drawn, 87.8% of region pairs overlapped. An SAE
 * decoder dictionary is close to isotropic in the residual basis, so it carries
 * real LOCAL neighbourhood structure and no macro-clusters to project.
 *
 * A boundary drawn anyway would imply a natural kind that is not there — the §3
 * "a map is a persuasive object" failure. So the map names its dense parts
 * instead: each place is a local maximum of the point density, labelled with
 * the terms most over-represented (plain TF-IDF) among the published
 * Neuronpedia explanations of the ~600 latents nearest it.
 *
 * A place is therefore a description, not a region. It has a position and no
 * edges, which is exactly as much as the data supports.
 */
import { TextLayer } from '@deck.gl/layers';
import { CollisionFilterExtension } from '@deck.gl/extensions';

export interface AtlasPlace {
  lon: number;
  lat: number;
  /** Distinctive terms, most distinctive first. */
  terms: string[];
  /** `terms` joined for display. */
  label: string;
  labelled_members: number;
  /** Peak density relative to the strongest peak, 0–1. */
  weight: number;
}

export const ATLAS_PLACES_LAYER_ID = 'atlas-places';

/**
 * One `TextLayer`, decluttered by deck's own collision extension.
 *
 * Priority is the peak's density, so when two labels collide the denser part of
 * the map keeps its name. Without this, ~60 labels over a single blob overlap
 * into an unreadable pile at low zoom — which is the failure mode the whole
 * layer exists to avoid.
 */
export function buildPlacesLayer(
  places: AtlasPlace[],
  opts: { dimmed: boolean },
): any {
  return new TextLayer({
    id: ATLAS_PLACES_LAYER_ID,
    data: places,
    getPosition: (d: AtlasPlace) => [d.lon, d.lat],
    getText: (d: AtlasPlace) => d.label,
    // Density sets the type size, so the map has a hierarchy to read rather
    // than sixty labels of equal weight.
    getSize: (d: AtlasPlace) => 10.5 + d.weight * 5.5,
    sizeUnits: 'pixels',
    getColor: opts.dimmed
      ? [200, 214, 236, 110]
      : ([226, 236, 252, 240] as [number, number, number, number]),
    // A halo, not a box: labels sit over a live point cloud and need to stay
    // readable without occluding what they are describing.
    outlineColor: [4, 6, 12, 255],
    outlineWidth: 3.5,
    fontSettings: { sdf: true, radius: 12 },
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontWeight: 500,
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    characterSet: 'auto',
    billboard: true,
    pickable: false,
    extensions: [new CollisionFilterExtension()],
    collisionEnabled: true,
    collisionGroup: 'atlas-places',
    getCollisionPriority: (d: AtlasPlace) => Math.round(d.weight * 100),
    collisionTestProps: { sizeScale: 1.25 },
  });
}
