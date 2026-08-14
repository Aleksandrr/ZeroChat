// Vitest global setup — runs before each test file.
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initSync } from '@getmaapp/signal-wasm';

// Polyfill TextEncoder/TextDecoder (jsdom provides them but make sure).
if (typeof globalThis.TextEncoder === 'undefined') {
  // @ts-ignore
  globalThis.TextEncoder = require('util').TextEncoder;
  // @ts-ignore
  globalThis.TextDecoder = require('util').TextDecoder;
}

// jsdom doesn't implement `fetch()` for `file://` URLs and the WASM
// bootstrap in signal-wasm calls `fetch(wasm_url)` by default. Pre-load
// the WASM bytes synchronously via initSync so that tests don't need
// network access.
let wasmInitialised = false;
export function ensureWasmSync() {
  if (wasmInitialised) return;
  const wasmPath = resolve(__dirname, '../node_modules/@getmaapp/signal-wasm/signal_wasm_bg.wasm');
  const bytes = readFileSync(wasmPath);
  initSync(bytes);
  wasmInitialised = true;
}

// Auto-initialise on import.
try {
  ensureWasmSync();
} catch (e) {
  console.warn('[test-setup] Could not pre-init signal-wasm:', e);
}
