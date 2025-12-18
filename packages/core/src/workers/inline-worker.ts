/**
 * Inline worker module stub
 * 
 * This file provides TypeScript types and a placeholder implementation.
 * The actual implementation is generated during build by scripts/build-worker.mjs
 * and placed in dist/workers/inline-worker.js
 * 
 * At runtime, the bundled version in dist is used, which contains the actual
 * base64-encoded worker code.
 */

// This will be replaced with the actual base64 code during build
export const WORKER_CODE_BASE64: string = '';

export function createWorkerBlob(): Blob {
  if (!WORKER_CODE_BASE64) {
    throw new Error('Worker code not available - build may have failed');
  }
  const code = atob(WORKER_CODE_BASE64);
  return new Blob([code], { type: 'application/javascript' });
}

export function createWorkerURL(): string {
  return URL.createObjectURL(createWorkerBlob());
}


