// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHighLimitDevice } from '../src/renderer/webgpu-renderer';

// Minimal fake WebGPU adapter/device so we can drive createHighLimitDevice
// without a real GPU. The whole point of the helper is that it reads the
// adapter's reported ceilings and asks for a device with exactly those
// `requiredLimits` (instead of Three's 256 MB default) — that's what we assert.

const ADAPTER_LIMITS = {
  maxBufferSize: 4_294_967_292,
  maxStorageBufferBindingSize: 2_147_483_644,
  // an unrelated limit we must NOT forward verbatim:
  maxTextureDimension2D: 16_384,
};

function installFakeGpu(overrides: Partial<{ adapter: unknown; throwOnDevice: boolean }> = {}) {
  const adapter = {
    features: new Set(['shader-f16', 'depth32float-stencil8']),
    limits: ADAPTER_LIMITS,
    requestDevice: async (desc: unknown) => {
      if (overrides.throwOnDevice) throw new Error('device request rejected');
      return { __device: true, requested: desc };
    },
  };
  const gpu = {
    requestAdapter: async () => ('adapter' in overrides ? overrides.adapter : adapter),
  };
  vi.stubGlobal('navigator', { gpu });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHighLimitDevice', () => {
  it('requests a device with buffer limits raised to the adapter maximum', async () => {
    installFakeGpu();
    const device = (await createHighLimitDevice()) as { requested: { requiredLimits: Record<string, number> } };
    expect(device).toBeTruthy();
    expect(device.requested.requiredLimits).toEqual({
      maxBufferSize: ADAPTER_LIMITS.maxBufferSize,
      maxStorageBufferBindingSize: ADAPTER_LIMITS.maxStorageBufferBindingSize,
    });
  });

  it("raises the cap well above Three's 256 MB single-buffer default", async () => {
    installFakeGpu();
    const device = (await createHighLimitDevice()) as { requested: { requiredLimits: Record<string, number> } };
    expect(device.requested.requiredLimits.maxBufferSize).toBeGreaterThan(268_435_456);
  });

  it('forwards every supported adapter feature (mirroring Three)', async () => {
    installFakeGpu();
    const device = (await createHighLimitDevice()) as { requested: { requiredFeatures: string[] } };
    expect(device.requested.requiredFeatures).toEqual(['shader-f16', 'depth32float-stencil8']);
  });

  it('returns undefined when WebGPU is unavailable (callers fall back to WebGL2)', async () => {
    vi.stubGlobal('navigator', {});
    expect(await createHighLimitDevice()).toBeUndefined();
  });

  it('returns undefined when no adapter is available', async () => {
    installFakeGpu({ adapter: null });
    expect(await createHighLimitDevice()).toBeUndefined();
  });

  it('swallows a rejected device request and returns undefined', async () => {
    installFakeGpu({ throwOnDevice: true });
    expect(await createHighLimitDevice()).toBeUndefined();
  });
});
