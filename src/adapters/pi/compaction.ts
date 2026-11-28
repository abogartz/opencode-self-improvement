import type {
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

/** Enrich preparation without replacing native summary routing, retries or tracking. */
export async function compactWithMemory(
  event: SessionBeforeCompactEvent,
  _ctx: ExtensionContext,
  anchors: string[],
): Promise<SessionBeforeCompactResult | void> {
  event.signal.throwIfAborted();
  const prior = event.branchEntries.findLast(
    (entry) => entry.type === "compaction",
  );
  // Pi skips file details on extension-generated summaries, including older
  // memory summaries. Carry the standard fields into its current preparation.
  if (prior?.type === "compaction" && prior.fromHook && prior.details) {
    const details = prior.details as {
      readFiles?: unknown;
      modifiedFiles?: unknown;
    };
    for (const [files, target] of [
      [details.readFiles, event.preparation.fileOps.read],
      [details.modifiedFiles, event.preparation.fileOps.edited],
    ] as const)
      if (Array.isArray(files))
        for (const file of files)
          if (typeof file === "string") target.add(file);
  }
  if (!anchors.length) return;
  // Only the summary input sees this context. The capture snapshot was bound
  // earlier, and no synthetic message is appended to the user's session.
  for (const messages of [
    event.preparation.messagesToSummarize,
    event.preparation.turnPrefixMessages,
  ])
    if (messages.length)
      messages.push({
        role: "custom",
        customType: "memory-compaction-context",
        content: anchors.join("\n\n"),
        display: false,
        timestamp: Date.now(),
      });
}
