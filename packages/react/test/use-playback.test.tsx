/**
 * usePlayback: the React lifecycle/wiring over the @poopdeck.gl/playback engine.
 *
 * The engine itself (TimeController + PlaybackGovernor behavior) is covered by
 * that package's own tests; here we assert the React adapter — that mounting
 * builds the controller + governor, the returned handlers route to the
 * governor's intent, options are reflected, a range change resets transient
 * state, and unmount disposes the governor. Fake timers + a stubbed rAF mirror
 * the governor test harness so nothing advances on its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { PlaybackGovernor } from "@poopdeck.gl/playback";
import { usePlayback } from "../src/hooks/use-playback";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePlayback", () => {
  it("builds the controller + governor and reflects initial state", () => {
    const { result } = renderHook(() =>
      usePlayback({ timeRange: { start: 1_000, end: 5_000 }, baseSpeed: 2_000 }),
    );
    expect(result.current.timeController).toBeDefined();
    expect(result.current.governor).not.toBeNull();
    expect(result.current.baseAnimationSpeed).toBe(2_000);
    expect(result.current.isPlaying).toBe(false);
    expect(result.current.currentTime).toBe(1_000); // seeded at the range start
  });

  it("defaults the base speed to 1000 when no option is given", () => {
    const { result } = renderHook(() => usePlayback());
    expect(result.current.baseAnimationSpeed).toBe(1_000);
  });

  it("play() and pause() toggle isPlaying via the governor's intent", () => {
    const { result } = renderHook(() =>
      usePlayback({ timeRange: { start: 0, end: 1_000 } }),
    );
    act(() => result.current.play());
    expect(result.current.isPlaying).toBe(true);
    act(() => result.current.pause());
    expect(result.current.isPlaying).toBe(false);
  });

  it("onSpeedChange sets the multiplier and exits Auto", () => {
    const { result } = renderHook(() =>
      usePlayback({ timeRange: { start: 0, end: 1_000 } }),
    );
    act(() => result.current.onSpeedChange(2));
    expect(result.current.speedMultiplier).toBe(2);
    expect(result.current.autoSpeed).toBe(false);
  });

  it("resets the speed multiplier when the time range changes", () => {
    const { result, rerender } = renderHook((props) => usePlayback(props), {
      initialProps: { timeRange: { start: 0, end: 1_000 }, baseSpeed: 1_000 },
    });
    act(() => result.current.onSpeedChange(3));
    expect(result.current.speedMultiplier).toBe(3);

    act(() => rerender({ timeRange: { start: 2_000, end: 4_000 }, baseSpeed: 1_000 }));
    expect(result.current.speedMultiplier).toBe(1); // range switch re-armed it
    expect(result.current.isPlaying).toBe(false);
  });

  it("honours initialTime when a timeRange is also given", () => {
    // Regression: the range effect used to run on mount (and again when the
    // governor arrived) and setTime(rangeStart), silently clobbering
    // initialTime — a deep-linked `?t=` playhead always snapped to the start.
    const { result } = renderHook(() =>
      usePlayback({ timeRange: { start: 1_000, end: 5_000 }, initialTime: 3_000 }),
    );
    expect(result.current.currentTime).toBe(3_000);
    expect(result.current.timeController.getTime()).toBe(3_000);
  });

  it("clamps an out-of-range initialTime into the range", () => {
    const { result } = renderHook(() =>
      usePlayback({ timeRange: { start: 1_000, end: 5_000 }, initialTime: 9_000 }),
    );
    expect(result.current.timeController.getTime()).toBe(5_000);
  });

  it("a LATER range change resets to the new range start (initialTime is mount-only)", () => {
    const { result, rerender } = renderHook((props) => usePlayback(props), {
      initialProps: {
        timeRange: { start: 1_000, end: 5_000 },
        initialTime: 3_000,
        baseSpeed: 1_000,
      },
    });
    expect(result.current.timeController.getTime()).toBe(3_000);
    act(() =>
      rerender({
        timeRange: { start: 10_000, end: 20_000 },
        initialTime: 3_000,
        baseSpeed: 1_000,
      }),
    );
    expect(result.current.timeController.getTime()).toBe(10_000);
  });

  it("disposes the governor on unmount", () => {
    const disposeSpy = vi.spyOn(PlaybackGovernor.prototype, "dispose");
    const { unmount } = renderHook(() =>
      usePlayback({ timeRange: { start: 0, end: 1_000 } }),
    );
    unmount();
    expect(disposeSpy).toHaveBeenCalled();
    disposeSpy.mockRestore();
  });
});
