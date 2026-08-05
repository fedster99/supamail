import type { MessageFlagSnapshot, MessageMetadata } from "./types.js";

export const MAX_SYNC_BATCH_SIZE = 500;
export const MAX_SYNC_METADATA_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_SYNC_ATTACHMENTS_PER_BATCH = 5_000;
export const MAX_SYNC_METADATA_LOGICAL_BYTES = 32 * 1024 * 1024;
export const MAX_SYNC_ATTACHMENTS_PER_LOGICAL_BATCH = 20_000;
export const MAX_SYNC_METADATA_FETCH_BYTES = MAX_SYNC_METADATA_LOGICAL_BYTES;
export const MAX_SYNC_ATTACHMENTS_PER_FETCH = MAX_SYNC_ATTACHMENTS_PER_LOGICAL_BATCH;
export const MAX_SYNC_FLAG_BATCH_BYTES = 1024 * 1024;
export const MAX_SYNC_FLAGS_PER_BATCH = 5_000;
export const MAX_SYNC_FLAG_LOGICAL_BYTES = 4 * 1024 * 1024;
export const MAX_SYNC_FLAGS_PER_LOGICAL_BATCH = 20_000;
export const MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES = 2 * MAX_SYNC_FLAG_LOGICAL_BYTES;
export const MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH = 2 * MAX_SYNC_FLAGS_PER_LOGICAL_BATCH;
export const MAX_SYNC_FLAG_EVENT_BATCH_BYTES = 2 * MAX_SYNC_FLAG_BATCH_BYTES;
export const MAX_SYNC_FLAGS_PER_EVENT_BATCH = 2 * MAX_SYNC_FLAGS_PER_BATCH;
export const MAX_SYNC_FLAG_FETCH_BYTES = MAX_SYNC_FLAG_LOGICAL_BYTES;
export const MAX_SYNC_FLAGS_PER_FETCH = MAX_SYNC_FLAGS_PER_LOGICAL_BATCH;
export const PARSED_BODY_BATCH_MAX_MESSAGES = 10;
export const PARSED_BODY_BATCH_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const PARSED_BODY_BATCH_MAX_TOTAL_SOURCE_BYTES = 8 * 1024 * 1024;

const MESSAGE_SERIALIZATION_OVERHEAD_BYTES = 128;
const ATTACHMENT_SERIALIZATION_OVERHEAD_BYTES = 64;

export function metadataMessageFootprint(message: MessageMetadata): {
  bytes: number;
  attachments: number;
} {
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch (error) {
    throw new Error(`Metadata for UID ${message.uid} is not JSON serializable`, { cause: error });
  }

  return {
    bytes: Buffer.byteLength(serialized, "utf8")
      + MESSAGE_SERIALIZATION_OVERHEAD_BYTES
      + message.attachments.length * ATTACHMENT_SERIALIZATION_OVERHEAD_BYTES,
    attachments: message.attachments.length
  };
}

export function splitMetadataWriteBatches(messages: MessageMetadata[]): MessageMetadata[][] {
  if (messages.length === 0) return [];

  const batches: MessageMetadata[][] = [];
  let batch: MessageMetadata[] = [];
  let batchBytes = 2;
  let batchAttachments = 0;
  let totalBytes = 2;
  let totalAttachments = 0;

  for (const message of messages) {
    const footprint = metadataMessageFootprint(message);
    if (footprint.bytes + 2 > MAX_SYNC_METADATA_BATCH_BYTES) {
      throw new Error(
        `Metadata for UID ${message.uid} exceeds the ${MAX_SYNC_METADATA_BATCH_BYTES}-byte write limit`
      );
    }
    if (footprint.attachments > MAX_SYNC_ATTACHMENTS_PER_BATCH) {
      throw new Error(
        `Metadata for UID ${message.uid} exceeds the ${MAX_SYNC_ATTACHMENTS_PER_BATCH}-attachment write limit`
      );
    }
    totalBytes += footprint.bytes;
    totalAttachments += footprint.attachments;
    if (totalBytes > MAX_SYNC_METADATA_LOGICAL_BYTES
      || totalAttachments > MAX_SYNC_ATTACHMENTS_PER_LOGICAL_BATCH) {
      throw new Error("Metadata batch exceeds the aggregate logical write limit");
    }

    const wouldExceedLimit = batch.length >= MAX_SYNC_BATCH_SIZE
      || batchBytes + footprint.bytes + (batch.length > 0 ? 1 : 0) > MAX_SYNC_METADATA_BATCH_BYTES
      || batchAttachments + footprint.attachments > MAX_SYNC_ATTACHMENTS_PER_BATCH;
    if (wouldExceedLimit && batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
      batchAttachments = 0;
    }

    batch.push(message);
    batchBytes += footprint.bytes + (batch.length > 1 ? 1 : 0);
    batchAttachments += footprint.attachments;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function flagSnapshotFootprint(
  message: MessageFlagSnapshot
): { bytes: number; flags: number } {
  return {
    bytes: Buffer.byteLength(JSON.stringify({ uid: message.uid, flags: message.flags }), "utf8") + 32,
    flags: message.flags.length
  };
}

export function splitFlagWriteBatches(messages: MessageFlagSnapshot[]): MessageFlagSnapshot[][] {
  if (messages.length === 0) return [];
  const batches: MessageFlagSnapshot[][] = [];
  let batch: MessageFlagSnapshot[] = [];
  let batchBytes = 2;
  let batchFlags = 0;
  let totalBytes = 2;
  let totalFlags = 0;

  for (const message of messages) {
    const footprint = flagSnapshotFootprint(message);
    if (footprint.bytes + 2 > MAX_SYNC_FLAG_BATCH_BYTES
      || footprint.flags > MAX_SYNC_FLAGS_PER_BATCH) {
      throw new Error(`Flags for UID ${message.uid} exceed the flag write limit`);
    }
    totalBytes += footprint.bytes;
    totalFlags += footprint.flags;
    if (totalBytes > MAX_SYNC_FLAG_LOGICAL_BYTES
      || totalFlags > MAX_SYNC_FLAGS_PER_LOGICAL_BATCH) {
      throw new Error("Flag scan batch exceeds the aggregate logical write limit");
    }
    const wouldExceedLimit = batch.length >= MAX_SYNC_BATCH_SIZE
      || batchBytes + footprint.bytes + (batch.length > 0 ? 1 : 0) > MAX_SYNC_FLAG_BATCH_BYTES
      || batchFlags + footprint.flags > MAX_SYNC_FLAGS_PER_BATCH;
    if (wouldExceedLimit && batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
      batchFlags = 0;
    }
    batch.push(message);
    batchBytes += footprint.bytes + (batch.length > 1 ? 1 : 0);
    batchFlags += footprint.flags;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function flagArrayFootprint(flags: readonly string[]): { bytes: number; flags: number } {
  return {
    bytes: flags.reduce((total, flag) => total + Buffer.byteLength(flag, "utf8") + 3, 2),
    flags: flags.length
  };
}

export function assertFlagEventSideWithinLimits(uid: number, flags: readonly string[]): void {
  const footprint = flagArrayFootprint(flags);
  if (footprint.bytes > MAX_SYNC_FLAG_BATCH_BYTES
    || footprint.flags > MAX_SYNC_FLAGS_PER_BATCH) {
    throw new Error(`Stored flags for UID ${uid} exceed the flag event limit`);
  }
}

export function splitFlagEventBatches<T extends {
  message: { uid: number };
  previousFlags: string[];
  nextFlags: string[];
}>(events: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 2;
  let batchFlags = 0;
  let totalBytes = 2;
  let totalFlags = 0;

  for (const event of events) {
    const previous = flagArrayFootprint(event.previousFlags);
    const next = flagArrayFootprint(event.nextFlags);
    const bytes = previous.bytes + next.bytes + 128;
    const flags = previous.flags + next.flags;
    if (bytes > MAX_SYNC_FLAG_EVENT_BATCH_BYTES || flags > MAX_SYNC_FLAGS_PER_EVENT_BATCH) {
      throw new Error(`Flag event for UID ${event.message.uid} exceeds the event write limit`);
    }
    totalBytes += bytes;
    totalFlags += flags;
    if (totalBytes > MAX_SYNC_FLAG_EVENT_LOGICAL_BYTES
      || totalFlags > MAX_SYNC_FLAGS_PER_EVENT_LOGICAL_BATCH) {
      throw new Error("Flag events exceed the aggregate logical write limit");
    }
    const wouldExceedLimit = batch.length > 0
      && (batchBytes + bytes + 1 > MAX_SYNC_FLAG_EVENT_BATCH_BYTES
        || batchFlags + flags > MAX_SYNC_FLAGS_PER_EVENT_BATCH);
    if (wouldExceedLimit) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
      batchFlags = 0;
    }
    batch.push(event);
    batchBytes += bytes + (batch.length > 1 ? 1 : 0);
    batchFlags += flags;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}
