import type { MirrorHooks, SyncResult } from "./types.js";

export async function emitSyncCompleted(hooks: MirrorHooks, result: SyncResult): Promise<void> {
  await hooks.onSyncRunCompleted?.(result);
}
