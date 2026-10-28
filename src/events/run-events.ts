/**
 * The Run events module: the event union and payload shapes, typed append
 * (through `EventStore`), payload decoding, and opening the event log.
 * Writers and the Run projection both go through it.
 */
export type { RunEventType, NewRunEvent, RunEventPayload, StoredRunEvent } from "./types.js";
export type * from "./payloads.js";
export { EventStore } from "./store.js";
export {
  decodeRunEvent,
  decodeTaskPlanHistory,
  isTypedRunEventType,
  type DecodedRunEventPayloads,
} from "./decode.js";
export {
  eventStorePath,
  openEventStoreAt,
  openRunEventStore,
  withRunEventStore,
} from "./open.js";
