// format — split from src/init.ts (#168 domain restructure). Declaration bodies are unchanged.
// Repository init: renders the runInit summary for the tool reply. The
// codebase-memory graph line is gone with the graph integration (#231).
import { type InitSummary } from "./run.ts";

export function formatInit(s: InitSummary): string {
  // #376 review: a migration whose file write failed is not a migration. The row
  // was honoured, so this run is still idempotent, but nothing was copied — the
  // reply says so instead of claiming a migration that left no file behind.
  const migrated = s.stampMigrated
    ? s.stampError
      ? " (stamp read from a store row; the copy to the stamp file failed)"
      : " (stamp migrated from a store row)"
    : "";
  // A retirement that did not land is named, in the same spirit as the re-tag
  // repair's partial count: the migration is durable, the row is still there,
  // and the operator reads which half failed (#376 review).
  const retireFault = s.stampRetireError
    ? `Legacy stamp row NOT retired (${s.stampRetireError}); it stays in the store, withheld from recall. Run init again.`
    : "";
  // #375: a repair that did something, or could not finish, is reported. A quiet
  // "Nothing to do." over a store that still holds a live poisoned row is the
  // failure this ticket exists to remove.
  const r = s.retag;
  const repair =
    r && (r.retagged || r.blocked || r.partial || r.remaining || r.unaudited)
      ? `\nInjection screen: re-tagged=${r.retagged}, blocked=${r.blocked}, partial=${r.partial}` +
        (r.unaudited ? `, ${r.unaudited} without an audit line` : "") +
        (r.remaining ? `, ${r.remaining} left (run init again)` : "") +
        (r.collateral.length
          ? `, ${r.collateral.length} retired by GATE-2 while re-tagging`
          : "")
      : "";
  if (s.skipped) {
    // The skip path can carry a stamp fault of its own: the migration honoured a
    // legacy row and could not write the file, so the next init re-migrates.
    // Silence here is what let a failed migration report success (#376 review).
    const fault = s.stampError
      ? `; stamp NOT recorded (${s.stampError}) — the migration will be retried`
      : "";
    return `Already initialized for ${s.scope} at head ${s.head} (stamp ${s.stampTs}). Nothing to do.${migrated}${fault}${retireFault ? `\n${retireFault}` : ""}${repair}`;
  }
  const scr = s.scripts.map((r2) => `- ${r2.source}: "${r2.cmd}"`).join("\n");
  const stamp = s.stampError
    ? `; stamp NOT recorded (${s.stampError}) — init will run again`
    : `; stamp=${s.stampTs ?? "-"}`;
  return [
    `Initialized ${s.scope} (root ${s.root}, head ${s.head}).`,
    scr ? `Scripts (${s.scripts.length}):\n${scr}` : "Scripts: none detected",
    `Memories: written=${s.written}, collapsed=${s.collapsed}, blocked=${s.blocked}` +
      (s.unaudited ? `, ${s.unaudited} without an audit line` : "") +
      stamp +
      migrated,
    retireFault,
    repair.trimStart(),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
