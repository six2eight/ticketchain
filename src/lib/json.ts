/** Recursively converts bigints to decimal strings so a value can be JSON-serialized. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

export const stringifyJsonSafe = (value: unknown) => JSON.stringify(toJsonSafe(value));
