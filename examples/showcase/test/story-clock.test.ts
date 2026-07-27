/**
 * /story/drifters clock reconciliation.
 *
 * The story globe bounds every drift/spin beat on the archive's END — the beat
 * plays forward from its moment to the last fix and then holds — so that end is
 * the story's most load-bearing number. It arrives ASYNCHRONOUSLY: mount
 * resolves against the authored `dataset.timeRange` placeholder and the real
 * extent only lands one manifest GET later (`useArchiveMetadata`).
 *
 * That makes two things testable without a renderer, and both were broken:
 *
 *  1. The FIRST beat (always the hero on a cold visit, module metadata cache
 *     empty) is applied against the placeholder. Nothing re-applied the range
 *     when the manifest resolved, so the hero clock ran to the placeholder's
 *     end for the whole beat. The correction must NOT be a re-seek: the beat is
 *     in progress and re-running the whole focus application would teleport the
 *     playhead back to the beat's start mid-beat (which is exactly why the
 *     component read the extent through a ref in the first place).
 *
 *  2. The placeholder itself. `/story/drifters` renders on it for the render or
 *     two before the manifest lands — and forever if the manifest never does —
 *     so unlike every other demo's authored range it is not merely a hint, it
 *     is a shipped clock bound. It therefore has to equal the archive extent
 *     EXACTLY, not "within the reconciliation tolerance"
 *     (dataset-archive-reconcile.test.ts allows max(bucketMs, 1% of span) here,
 *     which on this 43-year record is ~159 days — the reason a 6.75-day
 *     overshoot sailed through it).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeController } from '@poopdeck.gl/playback';
import {
  StoryClock,
  beatStartTime,
  beatTimeRange,
  type TimeRange,
} from '../src/components/story/storyClock';
import { ACTS, HERO_FOCUS, type GlobeFocus } from '../src/content/drifterStory';
import { getDatasetById } from '../src/datasets';

/** The drifters archive extent, read from the git-tracked density sidecar. */
function archiveExtent(): TimeRange {
  const path = fileURLToPath(
    new URL('../public/density/drifters.json', import.meta.url),
  );
  expect(existsSync(path), `density/drifters.json missing at ${path}`).toBe(
    true,
  );
  const j = JSON.parse(readFileSync(path, 'utf8')) as { timeRange: TimeRange };
  return j.timeRange;
}

/** The authored placeholder the story runs on until the manifest lands. */
function placeholderExtent(): TimeRange {
  const d = getDatasetById('ocean-drifters');
  expect(d, 'ocean-drifters missing from the registry').toBeDefined();
  return d!.timeRange;
}

/** A StoryClock over a real TimeController, recording every seek it commits. */
function harness(archive: TimeRange) {
  const controller = new TimeController({
    initialTime: HERO_FOCUS.time,
    loop: false,
    speed: 1,
    tickThrottleMs: 0,
  });
  const seeks: number[] = [];
  const clock = new StoryClock(
    {
      setTimeRange: (r) => controller.setTimeRange(r),
      seek: (t) => {
        seeks.push(t);
        controller.setTime(t);
      },
    },
    archive,
  );
  return { controller, clock, seeks };
}

const SWEEP_BEAT = ACTS.flatMap((a) => a.steps)
  .map((s) => s.focus)
  .find(
    (f): f is GlobeFocus & { sweep: { end: number } } => f.mode === 'sweep',
  );

describe('story clock ← archive extent', () => {
  it('the authored placeholder equals the archive extent exactly', () => {
    // Zero tolerance on purpose: this literal IS the clock for the first beat
    // of a cold visit, and the fallback forever if the manifest 404s.
    expect(placeholderExtent()).toEqual(archiveExtent());
  });

  it('corrects the first beat in place when the manifest lands (no re-seek)', () => {
    const archive = archiveExtent();
    // Cold visit: the metadata cache is empty, so mount resolves against the
    // authored placeholder. Pin a deliberately drifted end so the assertion
    // holds even after the registry literal is corrected.
    const placeholder: TimeRange = {
      start: archive.start,
      end: archive.end + 7 * 86_400_000,
    };
    const { controller, clock, seeks } = harness(placeholder);

    clock.applyFocus(HERO_FOCUS); // the hero beat, mode 'spin'
    expect(controller.getTimeRange()).toEqual({
      start: HERO_FOCUS.time,
      end: placeholder.end,
    });
    expect(seeks).toEqual([HERO_FOCUS.time]);

    // The beat has been running for a while — the playhead is past its start.
    const midBeat = HERO_FOCUS.time + 30 * 86_400_000;
    controller.setTime(midBeat);

    // …and now the manifest resolves.
    clock.setArchiveRange(archive);

    expect(
      controller.getTimeRange(),
      'the beat already on the clock must adopt the real archive end',
    ).toEqual({ start: HERO_FOCUS.time, end: archive.end });
    expect(
      seeks,
      'correcting the bound must NOT re-seek the beat back to its start',
    ).toEqual([HERO_FOCUS.time]);
    expect(controller.getTime(), 'the playhead must not move').toBe(midBeat);
  });

  it('corrects the beat ON the clock, not one pending behind a cross-dissolve', () => {
    // An era jump defers the destination beat to the fade trough, so the beat
    // the archive extent must correct is the one applyFocus last committed.
    const archive = archiveExtent();
    const placeholder: TimeRange = {
      start: archive.start,
      end: archive.end + 7 * 86_400_000,
    };
    const { controller, clock } = harness(placeholder);
    const applied = ACTS[0].steps[1].focus; // 'first-fix', mode 'drift'
    clock.applyFocus(applied);
    clock.setArchiveRange(archive);
    expect(controller.getTimeRange()).toEqual({
      start: applied.time,
      end: archive.end,
    });
  });

  it('never puts a NaN or undefined bound on the clock while metadata loads', () => {
    const archive = archiveExtent();
    const { controller, clock } = harness(archive);
    for (const focus of [
      HERO_FOCUS,
      ...ACTS.flatMap((a) => a.steps.map((s) => s.focus)),
    ]) {
      clock.applyFocus(focus);
      const r = controller.getTimeRange()!;
      expect(Number.isFinite(r.start), `${focus.mode} start`).toBe(true);
      expect(Number.isFinite(r.end), `${focus.mode} end`).toBe(true);
      expect(r.end).toBeGreaterThan(r.start);
      expect(Number.isFinite(controller.getTime())).toBe(true);
    }
    // A metadata resolve that somehow yields a broken range is ignored, not
    // pushed onto the clock.
    const before = controller.getTimeRange();
    clock.setArchiveRange({ start: NaN, end: NaN } as TimeRange);
    clock.setArchiveRange(undefined as unknown as TimeRange);
    expect(controller.getTimeRange()).toEqual(before);
  });

  it('opens the sweep on the first fix (Feb 1979) when its start is omitted', () => {
    const archive = archiveExtent();
    expect(SWEEP_BEAT, 'the story lost its sweep beat').toBeDefined();
    expect(
      SWEEP_BEAT!.sweep.start,
      'the sweep must inherit the archive start',
    ).toBeUndefined();
    expect(beatStartTime(SWEEP_BEAT!, archive)).toBe(archive.start);
    expect(new Date(archive.start).toISOString()).toBe(
      '1979-02-15T00:00:00.000Z',
    );
    expect(beatTimeRange(SWEEP_BEAT!, archive)).toEqual({
      start: archive.start,
      end: SWEEP_BEAT!.sweep.end,
    });
  });

  it('no beat runs past the archive end', () => {
    const archive = archiveExtent();
    for (const focus of [
      HERO_FOCUS,
      ...ACTS.flatMap((a) => a.steps.map((s) => s.focus)),
    ]) {
      const r = beatTimeRange(focus, archive);
      // 'still' beats pin a ±5-day snapshot bracket around an interior moment;
      // they never play, so their bracket is allowed to overhang.
      if (focus.mode === 'still') continue;
      expect(r.end, `${focus.mode} beat at ${focus.time}`).toBeLessThanOrEqual(
        archive.end,
      );
    }
  });
});
