import { EventEmitter } from "node:events";
import type { LedgerEntry, LedgerEntryInput, LedgerStore } from "../state/ledger.js";

export interface NotifyingLedgerStore extends LedgerStore {
  /** Emits "entry" with the newly-appended LedgerEntry after every append() — the source for the SSE stream (see routes/stream.ts). */
  events: EventEmitter;
}

/**
 * A thin decorator around a real LedgerStore that adds a live "entry appended" event,
 * without changing src/state/ledger.ts itself — the hash-chain implementation stays
 * exactly as proven in isolation; only the API layer needs "live," so only the API
 * layer carries that behavior.
 */
export function wrapWithNotifications(ledger: LedgerStore): NotifyingLedgerStore {
  const events = new EventEmitter();
  events.setMaxListeners(0); // an unbounded number of SSE subscribers may accumulate over the server's lifetime

  return {
    ...ledger,
    append(entry: LedgerEntryInput): LedgerEntry {
      const result = ledger.append(entry);
      events.emit("entry", result);
      return result;
    },
    events,
  };
}
