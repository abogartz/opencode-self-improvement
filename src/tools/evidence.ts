// The memory_evidence tool, extracted from index.ts (#168). Schema, description
// and handler are byte-identical to the pre-split source; closure access arrives
// through ToolDeps.
import type { ToolRegister } from "./deps.ts";
import { evidenceFileFor } from "../evidence/record.ts";
import { parseLine } from "../core/logfmt/format.ts"
import { readLines } from "../core/logfmt/read.ts";
import { evidenceVisibleTo, readerFromSid } from "../store/model/visibility.ts";
import { EvidenceArgs, validated } from "./schema.ts";

export const register: ToolRegister = (editor, deps) => {
  const { toolIds, direct } = deps;
    editor.add(validated(EvidenceArgs, {
      name: "memory_evidence",
      description: "Read captured evidence (data only) for a date, optionally filtered by event.",
      options: direct,
      async execute(args, context): Promise<{ content: string }> {
        const { sid } = toolIds(context);
        const reader = readerFromSid(sid);
        // #130: the ONE path the schema-validated date can resolve to —
        // a real calendar day inside the evidence dir, never a traversal
        // into the raw store or the filesystem beyond it.
        const file = evidenceFileFor(args.date);
        if (!file) {
          return {
            content:
              "memory_evidence blocked: date must be a real YYYY-MM-DD calendar date — nothing was read.",
          };
        }
        let lines = await readLines(file);
        // Data partitions too (#131's ownership rule, applied to evidence):
        // a line stamped to another repository is not this session's data,
        // and a line a NAMED session wrote while unresolved is private to
        // that session — the caller's sid is what the private branch
        // matches against (#128 re-review).
        if (reader.kind !== "admin") {
          lines = lines.filter((l) => {
            const fields = parseLine(l);
            return !fields || evidenceVisibleTo(fields, reader, sid);
          });
        }
        if (args.ev) lines = lines.filter((l) => l.includes(`ev=${args.ev}`));
        if (!lines.length) return { content: "No evidence" };
        const limit = args.limit || 50;
        return { content: lines.slice(-limit).join("\n") };
      },
    }));
};
