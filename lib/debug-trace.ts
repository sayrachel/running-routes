/**
 * Lightweight structured trace buffer for algorithm debugging.
 *
 * The route-quality harness enables tracing, runs a fixture, then flushes the
 * buffer to capture all decision points the algorithm went through. Disabled
 * by default so production code pays no cost.
 */

export interface TraceEvent {
  event: string;
  data: unknown;
}

let enabled = false;
let buffer: TraceEvent[] = [];

export function enableTrace(): void {
  enabled = true;
  buffer = [];
}

export function disableTrace(): void {
  enabled = false;
  buffer = [];
}

export function isTraceEnabled(): boolean {
  return enabled;
}

export function emit(event: string, data: unknown = {}): void {
  if (enabled) buffer.push({ event, data });
}

export function flushTrace(): TraceEvent[] {
  const out = buffer;
  buffer = [];
  return out;
}
