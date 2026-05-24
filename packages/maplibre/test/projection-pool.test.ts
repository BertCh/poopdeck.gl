/**
 * Worker pool tests. Run under Node where `Worker` is not present, so we
 * exercise the in-thread fallback path. The fallback must produce
 * bit-identical results to the main-thread `projectPositions` helper, since
 * the worker reimplements the same formula.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ProjectionWorkerPool,
  resetProjectionPool,
  getProjectionPool,
} from '../src/worker/projection-pool';
import { projectPositions } from '../src/projection';

describe('ProjectionWorkerPool (in-thread fallback)', () => {
  afterEach(() => {
    resetProjectionPool();
  });

  it('reuses the singleton', () => {
    const a = getProjectionPool();
    const b = getProjectionPool();
    expect(a).toBe(b);
  });

  it('produces the same projection as the synchronous helper', async () => {
    const pool = new ProjectionWorkerPool();
    const input = new Float64Array([0, 0, 180, 45, -90, -45]);
    const projected = await pool.project(input, 2);
    const expected = projectPositions(new Float64Array([0, 0, 180, 45, -90, -45]), 2);
    expect(projected.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(projected[i]).toBeCloseTo(expected[i], 8);
    }
    pool.destroy();
  });

  it('preserves z-channel for 3D inputs', async () => {
    const pool = new ProjectionWorkerPool();
    const projected = await pool.project(
      new Float64Array([0, 0, 1234, 90, 30, 5678]),
      3,
    );
    expect(projected[2]).toBe(1234);
    expect(projected[5]).toBe(5678);
    pool.destroy();
  });
});
