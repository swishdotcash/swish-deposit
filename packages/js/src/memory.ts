import type { Memory, Remembered } from "./flow.js";

const MEMORY_KEY = "swish-deposit";

/** Remembers the last wallet in this browser. Losing it costs nothing: the passkey is the identity. */
export function browserMemory(): Memory {
  return {
    load() {
      try {
        const r = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "null") as Partial<Remembered> | null;
        return r && typeof r.credentialId === "string" && typeof r.wallet === "string"
          ? { credentialId: r.credentialId, wallet: r.wallet }
          : null;
      } catch {
        return null;
      }
    },
    save(r) {
      try {
        localStorage.setItem(MEMORY_KEY, JSON.stringify(r));
      } catch {
        // Private windows may refuse storage; the widget works without it.
      }
    },
    clear() {
      try {
        localStorage.removeItem(MEMORY_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}
