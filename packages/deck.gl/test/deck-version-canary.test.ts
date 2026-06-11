/**
 * CI canaries for version-sensitive constructs that lean on deck.gl
 * INTERNALS the `>=9.3.0 <10` peer range does not contract:
 *
 * - VatTripsLayer's hand-written `#version 300 es` shaders reference the
 *   assembled `project` shader module directly — the `projectUniforms` UBO
 *   (instanced as `project`) and its `viewportSize` member, plus the
 *   project_* GLSL functions. None of these are public API; a deck.gl minor
 *   bump that renames or restructures them produces a silent shader
 *   compile/link failure at runtime. These assertions turn that into red CI.
 *
 * The sibling canary for NoPickingPathLayer's regex rewrite (which reads the
 * installed @deck.gl/layers PathLayer vertex source from disk) lives in
 * no-picking-path-layer.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { project, project32 } from '@deck.gl/core';

describe('deck.gl project shader module canary (VAT dependency)', () => {
  it('still exposes a vs GLSL source to assemble against', () => {
    expect(project.name).toBe('project');
    expect(typeof project.vs).toBe('string');
  });

  it('declares the projectUniforms block instanced as `project`', () => {
    // VAT samples `project.viewportSize` — the block instance name is part
    // of the contract, not just the member.
    expect(project.vs).toMatch(/uniform\s+projectUniforms\s*\{[^}]*\}\s*project\s*;/s);
  });

  it('keeps `viewportSize` as a member of the project UBO', () => {
    const block = project.vs!.match(/uniform\s+projectUniforms\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(block).toMatch(/vec2\s+viewportSize\s*;/);
  });

  it('keeps the project_* helpers VAT calls', () => {
    // VAT assembles with [project32, …]; project32 contributes
    // project_position_to_clipspace and depends on project for the rest.
    expect(project32.dependencies?.some((d: { name: string }) => d.name === 'project')).toBe(
      true,
    );
    expect(project32.vs).toContain('project_position_to_clipspace');
    for (const fn of ['project_size_to_pixel', 'project_pixel_size_to_clipspace']) {
      expect(project.vs).toContain(fn);
    }
  });
});
