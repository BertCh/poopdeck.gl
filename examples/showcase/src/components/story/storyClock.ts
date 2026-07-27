/**
 * storyClock — the beat → clock mapping for /story/drifters, lifted out of the
 * React component so it can be reasoned about (and tested) without a renderer.
 *
 * StoryGlobe drives one TimeController from two independent, asynchronous
 * sources:
 *   1. the SCROLL, which hands it a new {@link GlobeFocus} (a beat), and
 *   2. the ARCHIVE, whose real temporal extent arrives one manifest GET after
 *      mount (`useArchiveMetadata`) — until then the authored
 *      `dataset.timeRange` stands in as a placeholder.
 *
 * Those two arrive in either order, and the drift/spin beats bound their play
 * on the archive's END, so a beat applied before the manifest lands is applied
 * against the placeholder. This module keeps the two apart:
 *   • {@link StoryClock.applyFocus} is the SCROLL entry point — it sets the
 *     beat's range and seeks the clock to the beat's moment.
 *   • {@link StoryClock.setArchiveRange} is the ARCHIVE entry point — it
 *     re-derives the range of the beat that is ALREADY on the clock and pushes
 *     it, and deliberately never seeks. A late manifest must correct the bound
 *     of a beat in progress without teleporting the playhead back to its start.
 */
import type { GlobeFocus } from '../../content/drifterStory';
import { DAY } from '../../content/drifterStory';

export interface TimeRange {
  start: number;
  end: number;
}

/** A 'still' beat freezes a snapshot; this is the range it pins around it. */
const STILL_HALF_WINDOW_MS = 5 * DAY;

function isFiniteRange(r: TimeRange | undefined | null): r is TimeRange {
  return (
    !!r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start
  );
}

/**
 * The clock range a beat wants, given the archive's extent.
 *
 *  • sweep — the authored span; an omitted `sweep.start` means "from the
 *    beginning of the archive" (the first fix), filled in here.
 *  • still — a ±5-day snapshot bracket around the beat's moment. Independent
 *    of the archive, so a late manifest can't move it.
 *  • drift / spin — play forward from the beat's moment to the END of the
 *    archive and then hold. That end is the story's most load-bearing number:
 *    every drift/spin beat runs into it, so a value past the last fix is
 *    literally dead air at the close of the beat.
 */
export function beatTimeRange(f: GlobeFocus, archive: TimeRange): TimeRange {
  if (f.mode === 'sweep' && f.sweep) {
    return { start: f.sweep.start ?? archive.start, end: f.sweep.end };
  }
  if (f.mode === 'still') {
    return {
      start: f.time - STILL_HALF_WINDOW_MS,
      end: f.time + STILL_HALF_WINDOW_MS,
    };
  }
  return { start: f.time, end: archive.end };
}

/** The moment a beat opens on (what the clock is seeked to). */
export function beatStartTime(f: GlobeFocus, archive: TimeRange): number {
  return f.mode === 'sweep' && f.sweep
    ? (f.sweep.start ?? archive.start)
    : f.time;
}

/**
 * The two clock operations StoryGlobe owns. `seek` routes through the
 * PlaybackGovernor when there is one (so the jump flushes the old era's stale
 * prefetch and re-gates on the destination runway) and falls back to a plain
 * `setTime`.
 */
export interface StoryClockPorts {
  setTimeRange(range: TimeRange): void;
  seek(time: number): void;
}

export class StoryClock {
  private ports: StoryClockPorts;
  private archive: TimeRange;
  /**
   * The beat whose range is currently ON the clock — NOT the beat the page has
   * scrolled to. During an era cross-dissolve the destination beat is held in
   * StoryGlobe's `pendingFocusRef` and only committed at the fade trough, so
   * this is the one a late archive extent must correct.
   */
  private appliedFocus: GlobeFocus | null = null;

  constructor(ports: StoryClockPorts, archive: TimeRange) {
    this.ports = ports;
    this.archive = archive;
  }

  /** The archive extent the beats are currently bounded by. */
  get archiveRange(): TimeRange {
    return this.archive;
  }

  /** Scroll entry point: put a beat on the clock and jump to its moment. */
  applyFocus(f: GlobeFocus): void {
    this.appliedFocus = f;
    this.ports.setTimeRange(beatTimeRange(f, this.archive));
    this.ports.seek(beatStartTime(f, this.archive));
  }

  /**
   * Archive entry point: adopt the real extent once the manifest lands, and
   * re-derive the range of the beat that is ALREADY on the clock so it stops
   * running against the placeholder.
   *
   * Deliberately NOT `applyFocus(appliedFocus)`: that would seek, and the beat
   * is in progress — the playhead would teleport back to the beat's start the
   * moment the manifest resolved. Pushing only the range moves nothing
   * (`TimeController.setTimeRange` just stores the bounds; the playhead is
   * clamped against them on the next tick), so the correction is invisible.
   * The one visible case is a playhead that had ALREADY run past the corrected
   * end, which the next tick clamps + 'ended's — the intended outcome (stop at
   * the last fix), and unreachable anyway: the manifest lands within a second
   * of mount and no beat covers years of sim-time in a second.
   *
   * A broken range (an archive that reports NaN, or no range at all) is
   * ignored rather than pushed — the placeholder keeps the clock sane, which is
   * the whole contract `useArchiveMetadata` promises ("undefined while loading
   * AND on any error").
   */
  setArchiveRange(range: TimeRange): void {
    if (!isFiniteRange(range)) return;
    if (range.start === this.archive.start && range.end === this.archive.end) {
      return;
    }
    this.archive = range;
    // Nothing on the clock yet (the extent arrived before the first beat was
    // applied) — applyFocus will read the fresh extent when it runs.
    if (!this.appliedFocus) return;
    this.ports.setTimeRange(beatTimeRange(this.appliedFocus, range));
  }
}
