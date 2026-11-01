// The memory_import tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { runWriteGate } from "../gates.ts";
import { importMemories } from "../portable.ts";
import { ImportArgs, validated } from "../schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, bindSessionIdentity, ownerlessWriter, refuseOwnerlessWrite, gateContext, direct } = deps;
    editor.add(validated(ImportArgs, {
      name: "memory_import",
      description:
        "Import memories from a JSONL export (see memory_export). Every row goes through the same 4-gate write pipeline as memory_remember (tagged `import`, original tags preserved), so duplicates collapse and ungrounded rows are blocked exactly as usual — those are normal tallied outcomes, not errors. Malformed lines are skipped and counted. `file` must be inside the memory root — copy the export there first. Frontier policy: status:\"open\" exempts a row from ref grounding, so it requires a memory_export header and cannot claim global scope; imported repo stamps are kept only when they match the importing session's repo, otherwise the importing repo is stamped. A stamped open row is downgraded when there is no current repo scope to verify it. Imported content is unverified by construction: injected rows surface a `[via import]` provenance marker.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        // Resolve before touching the file: every imported row is re-stamped
        // with the IMPORTING session's repository, so an unresolved caller
        // would move a whole export into whoever set up last (#152).
        await bindSessionIdentity(sid);
        const ownerless = ownerlessWriter(sid);
        if (ownerless) return await refuseOwnerlessWrite(ownerless, "import");
        const importGate = gateContext(sid);
        try {
          const t = await importMemories(
            args.file,
            (c) =>
              runWriteGate(
                { ...c, tags: [...new Set([...(c.tags ?? []), "import"])] },
                importGate,
              ),
            sid,
          );
          return {
            content:
              `Imported ${args.file}: ${t.promoted} promoted, ${t.collapsed} duplicates collapsed, ` +
              `${t.blocked} blocked by the gate, ${t.skipped} malformed lines skipped.` +
              (t.quarantined ? ` ${t.quarantined} promoted ${t.quarantined === 1 ? "row" : "rows"} quarantined: withheld from recall/injection until human release in the viewer.` : "") +
              (t.downgraded
                ? ` ${t.downgraded} open rows downgraded to settled (missing eligible memory_export header or verifiable repo scope).`
                : "") +
              // Rows that landed without their write_promoted line are
              // durable but invisible to memory_evidence (#155 review) —
              // the tally owes the reader the count, not silence.
              (t.unaudited
                ? ` ${t.unaudited} promoted rows landed without their write_promoted audit line (${t.auditError}); memory_evidence will miss them.`
                : ""),
          };
        } catch (err) {
          return {
            content: `memory_import failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    }));
};
