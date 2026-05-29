// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * Lightweight "warn once" helper used by the extensions to surface
 * precision / palette / picking-attribute warnings without spamming the
 * console on every frame. The first invocation of each key writes to
 * `console.warn`; subsequent calls are no-ops.
 */

const SEEN = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (SEEN.has(key)) return;
  SEEN.add(key);
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** Test-only — reset the dedupe set so a test can assert the warning fires. */
export function _resetWarnOnce(): void {
  SEEN.clear();
}
