export const DEBUG_LATENCY_HEADER_NAME = "x-debug-latency";
export const DEBUG_LATENCY_HEADER_ENABLED_VALUE = "1";

export function hasEnabledDebugLatencyHeader(value) {
  if (Array.isArray(value)) {
    return value.some((item) => hasEnabledDebugLatencyHeader(item));
  }
  return typeof value === "string" && value.trim() === DEBUG_LATENCY_HEADER_ENABLED_VALUE;
}