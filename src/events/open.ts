import { join } from "node:path";

import { EventStore } from "./store.js";

/** The Run event log of a repository. */
export function eventStorePath(repoPath: string): string {
  return join(repoPath, ".nitely", "events.db");
}

/**
 * Opens an event log at an explicit path, for logs that are not a
 * repository's Run event log (CI repair, evidence copies, replays).
 */
export function openEventStoreAt(path: string): EventStore {
  return new EventStore(path);
}

/** Opens the repository's Run event log. The caller closes it. */
export function openRunEventStore(repoPath: string): EventStore {
  return openEventStoreAt(eventStorePath(repoPath));
}

/**
 * Runs `operation` against the repository's Run event log. When the caller
 * already holds an open handle it is reused and left open; otherwise one is
 * opened and closed around the operation.
 */
export function withRunEventStore<T>(
  repoPath: string,
  operation: (store: EventStore) => T,
  existing?: EventStore,
): T {
  if (existing) return operation(existing);
  const store = openRunEventStore(repoPath);
  try {
    const result = operation(store);
    if (result instanceof Promise) {
      return result.finally(() => store.close()) as T;
    }
    store.close();
    return result;
  } catch (error) {
    store.close();
    throw error;
  }
}
