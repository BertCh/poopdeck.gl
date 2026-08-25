/**
 * Camera constraints shared by the viewers and the dataset↔archive reconcile
 * gate, so the registry check and the map-level defaults read ONE number.
 */

/**
 * The pitch at which deck's default `altitude: 1.5` camera puts the top of the
 * screen at/above the horizon resolves to 71.57°; past it `unproject` returns a
 * point behind the camera and the viewport lon/lat box the tile loader selects
 * against inverts (zero tiles on one axis, a near-whole-world span on the
 * other). 70 is the shipped ceiling — comfortably under, still dramatic. It
 * bounds every authored `maxPitch` AND the terrain map's fallback (that path
 * used to default to 85; tile-loading audit 2026-08 F10). Raising it needs
 * docs/roadmap/tile-loading-3d-2026-07.md §4 read first.
 */
export const MAX_SAFE_PITCH = 70;
