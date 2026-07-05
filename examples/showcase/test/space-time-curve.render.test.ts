import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import SpaceTimeCurve, { __test } from "../src/components/how/SpaceTimeCurve.tsx";

const { ORDERS, STATS, SEEKS, CELLS, SEGS, HOLD, Cube, ByteStrip } = __test;
const ORDER_KEYS = Object.keys(ORDERS) as (keyof typeof ORDERS)[];
const QUERY_KEYS = ["scrub", "pan"] as const;

describe("SpaceTimeCurve data model", () => {
  it("every ordering visits all 64 cells exactly once", () => {
    for (const k of ORDER_KEYS) {
      const order = ORDERS[k];
      expect(order.length).toBe(CELLS);
      const keys = new Set(order.map((c) => `${c.x},${c.y},${c.t}`));
      expect(keys.size).toBe(CELLS);
    }
  });

  it("hilbert3 has zero seeks — every consecutive pair is grid-adjacent", () => {
    expect(SEEKS.hilbert3).toBe(0);
  });

  it("each query touches 16 tiles under every ordering", () => {
    for (const k of ORDER_KEYS)
      for (const q of QUERY_KEYS) expect(STATS[k][q].positions.length).toBe(16);
  });

  it("run counts land on the story: spatial 1/16, time 4/1", () => {
    expect(STATS.spatial.scrub.runs.length).toBe(1);
    expect(STATS.spatial.pan.runs.length).toBe(16);
    expect(STATS.time.pan.runs.length).toBe(1);
  });
});

describe("SpaceTimeCurve rendering", () => {
  it("the page component renders at initial state", () => {
    expect(renderToString(React.createElement(SpaceTimeCurve))).toContain("svg");
  });

  it("Cube and ByteStrip render for every order × query × drawn value, including out-of-range", () => {
    const drawnValues: number[] = [-2, -0.5, 0, 0.25, 1, 31.5, 62, 62.9, 63, 63.5, SEGS + HOLD, 100, NaN];
    for (let d = 0; d <= SEGS; d += 0.5) drawnValues.push(d);
    for (const order of ORDER_KEYS) {
      for (const query of QUERY_KEYS) {
        for (const drawn of drawnValues) {
          expect(() =>
            renderToString(React.createElement(Cube, { order, query, drawn, animating: true })),
          ).not.toThrow();
          expect(() =>
            renderToString(React.createElement(ByteStrip, { order, query, drawn })),
          ).not.toThrow();
        }
      }
    }
  });
});
