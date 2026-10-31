// Input-boundary schemas. ONE definition per boundary serves both sides:
// the JSON Schema handed to the host/model is GENERATED from these zod
// schemas, and every raw tool call / viewer POST is re-parsed through them
// before touching any business logic. Keeping a hand-written wire schema next
// to a runtime validator would just recreate the drift surface zod removes.
//
// Scope — shape, not meaning:
//   * Numbers coerce (z.coerce.number): `limit: "20"` means 20, and stringified
//     numerics already worked downstream, so coercion is strictly non-breaking.
//   * Booleans and strings stay strict. z.coerce.boolean() is JS Boolean() —
//     "false" would coerce to TRUE, silently flipping a dry run into a
//     mutation; a rejected call gets a clear error the model can fix instead.
//   * Nothing here validates semantics (a well-shaped lie still passes) —
//     that is what the 4-gate pipeline is for.
//   * Store reads deliberately do NOT use zod: they get a plain ISO-instant
//     check in memory.ts (row identity), where the row schema lives.
import { z, type ZodTypeAny } from "zod";
import { STATUSES, TYPES } from "./types.ts";
import { flattenMemoryText } from "./sanitize.ts";
import { MAX_KEYWORDS } from "./memory.ts";

type JSONSchema = Record<string, unknown>;

/** Row identity anywhere it arrives off a boundary: an ISO instant. */
export const isoTs = z.iso.datetime();

// Structured row fields become labels in model-facing text. Content remains
// multiline by design and is flattened only when rendered; metadata controls
// are rejected at every write boundary instead. Lookup-only scopes (recall,
// forget, export) stay plain strings so a row stored before this check can
// still be found and forgotten.
const memoryField = z.string().refine((value) => flattenMemoryText(value) === value, {
  message: "must not contain control characters",
});

// Retrieval keywords (#40). The shape cap mirrors MAX_KEYWORDS in memory.ts,
// which is the authority at write time (it also lowercases, de-dupes and drops
// over-long entries rather than rejecting the write).
const keywordList = z
  .array(memoryField)
  .max(MAX_KEYWORDS)
  .describe(
    "3-5 keywords for how a FUTURE session would search for this row: aliases and alternate names, verb forms, synonyms of the words you used, the literal command or file name. Indexed for matching only — never shown in an injected block. Skip it when the prose already says it.",
  )
  .optional();

// ---- tool argument schemas (JSON Schema generated from these) ------------

export const RememberArgs = z.object({
  type: z.enum(TYPES).describe("Type of memory"),
  scope: memoryField.describe("Scope/area (e.g., auth, api, ctl)"),
  content: z.string().describe("The memory content"),
  issue: memoryField.describe("Related issue").optional(),
  tags: z.array(memoryField).optional(),
  kw: keywordList,
  status: z
    .enum(STATUSES)
    .describe(
      "open = live planning thread / frontier (surfaced at session start); settled or omitted = durable knowledge",
    )
    .optional(),
  global: z
    .boolean()
    .describe(
      "Store cross-project (visible in every repo): user preferences and general tooling habits. Default false = the memory belongs to THIS repo.",
    )
    .optional(),
});

export const InitArgs = z.object({
  force: z.boolean().describe("Re-run even if initialized (refresh after drift)").optional(),
  mode: z
    .enum(["fast", "moderate", "full"])
    .describe("codebase-memory index mode (default moderate)")
    .optional(),
});

export const RecallArgs = z.object({
  scope: z.string().optional(),
  type: z.enum(TYPES).optional(),
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const UpdateArgs = z.object({
  scope: memoryField,
  type: z.enum(TYPES),
  content: z.string(),
  kw: keywordList,
  query: z
    .string()
    .describe(
      "Row selector: id (ts), clock fragment, or unique content substring. Omit to target the newest active row of scope+type.",
    )
    .optional(),
  status: z
    .enum(STATUSES)
    .describe("Settled or open; omitted keeps the target row's standing (an open frontier row stays open)")
    .optional(),
});

export const ForgetArgs = z.object({
  scope: z.string(),
  type: z.enum(TYPES),
  reason: z.string().describe("Why this is being deleted (audit)"),
});

export const EmptyArgs = z.object({});

export const UndoArgs = z.object({
  list: z.boolean().describe("List snapshots").optional(),
  snapshot: z
    .string()
    .describe("Store-owned snapshot to restore (bare name from list, or its full path)")
    .optional(),
  merge: z
    .boolean()
    .describe("With snapshot: keep rows written after the snapshot instead of refusing")
    .optional(),
  force: z
    .boolean()
    .describe("With snapshot: exact rollback even if the file changed since")
    .optional(),
});

export const EvidenceArgs = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD calendar date (paths are refused)")
    .optional(),
  ev: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const MergeReviewArgs = z.object({
  loser: z
    .string()
    .describe("Ts id of the stored losing row to supersede (a blocked write was never stored and has no id)"),
  survivor: z.string().describe("Ts id of the stored canonical winning row"),
  reason: z.string().describe("Why the survivor is canonical over the loser (written to evidence)"),
});

export const ConsolidateArgs = z.object({
  scope: z.string().describe("Only consider rows in this scope").optional(),
  jaccard: z
    .number()
    .describe("Similarity floor for 'same statement' (default 0.55)")
    .min(0.2)
    .max(0.95)
    .optional(),
  limit: z.number().describe("Maximum proposals to report (default 10)").min(1).max(50).optional(),
});

export const ExportArgs = z.object({
  scope: z.string().describe("Only export memories in this exact scope").optional(),
  file: z
    .string()
    .describe(
      "Destination inside <memory-root>/exports/ (a relative path resolves against it). Default: <memory-root>/exports/<timestamp>-<unique>.jsonl, unique per export",
    )
    .optional(),
});

export const ImportArgs = z.object({
  file: z.string().describe("Path to a .jsonl export file, inside the memory root"),
});

export const DecayArgs = z.object({
  olderThanDays: z
    .coerce
    .number()
    .optional()
    .meta({ default: 14 })
    .describe("Age threshold in days (default 14)"),
  // Strict boolean on purpose: only a real JSON false mutates. A string
  // "false" is rejected with guidance, never coerced into `true` (see header).
  dryRun: z
    .boolean()
    .optional()
    .meta({ default: true })
    .describe("Preview only (default true). Set false to actually supersede."),
});

// ---- viewer request bodies (the boundary here is the network) ------------
// /api/restore is NOT here: its `name` grammar (basename + pinned regex) is
// containment logic with its own regression tests, not a shape gate.

export const EditBody = z.object({
  ts: isoTs,
  type: z.enum(TYPES),
  scope: memoryField.min(1),
  content: z.string().min(1),
  issue: memoryField.optional(),
  tags: z.array(memoryField).optional(),
  // min NOT enforced here: the mutate layer owns the audit-reason contract
  // (and its tests pin its message). Shape is the boundary's job only.
  reason: z.string(),
});

export const DeleteBody = z.object({ ts: isoTs, reason: z.string() });
export const BlockBody = z.object({ ts: isoTs, reason: z.string() });
export const UnblockBody = z.object({ ts: isoTs });
// #35: lift a value-keyed rejection. `ch` is the 12-hex content hash the gate's
// block hint names, and the same identifier a `dedup_rejected` evidence line
// carries — so a human can act on either without reading the store by hand.
export const UnrejectBody = z.object({ ch: z.string().regex(/^[0-9a-f]{12}$/) });
// Strict fields by intent: String(body.x ?? "") coercion once let unvalidated
// POSTs append rows with empty type/scope/content.
// repo/repoPath (#129): the origin stamp of the DELETED row, replayed from the
// audit line so a restore-entry keeps the row's original visibility instead of
// silently landing global. Both absent = the documented legacy global restore.
export const RestoreEntryBody = z.object({
  type: z.enum(TYPES),
  scope: memoryField.min(1),
  content: z.string().min(1),
  repo: memoryField.min(1).max(64).optional(),
  repoPath: memoryField.min(1).max(4096).optional(),
});

// ---- wiring ---------------------------------------------------------------

/**
 * Generate the host-facing JSON Schema. Matches the pre-zod hand-written
 * builders byte-for-byte modulo key order (test/boundaries.test.ts pins all
 * 13 against a capture from main): $schema stripped, empty `required` kept.
 */
export function wire(schema: ZodTypeAny): JSONSchema {
  const out = z.toJSONSchema(schema) as JSONSchema;
  delete out.$schema;
  out.required ??= [];
  return out;
}

export interface ToolDef<S extends ZodTypeAny> {
  name: string;
  description: string;
  options: { codemode: false };
  // The second argument is the host's per-call execution context (V2 SDK
  // ToolContext carries sessionID/messageID/id). It is optional because the
  // V1-shaped test harness and direct callers omit it; tools must fall back
  // to the ambient current, which is only safe SYNCHRONOUSLY at entry.
  execute(args: z.infer<S>, context?: unknown): Promise<{ content: string }>;
}

/**
 * Register a tool: wire schema from zod + runtime re-parse of raw args.
 * A malformed call returns a self-describing error the model can act on —
 * nothing was done — instead of throwing inside the host or coercing junk
 * into the store.
 */
export function validated<S extends ZodTypeAny>(
  schema: S,
  def: ToolDef<S>,
): ToolDef<S> & { input: JSONSchema } {
  return {
    ...def,
    input: wire(schema),
    async execute(raw: unknown, context?: unknown): Promise<{ content: string }> {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
        );
        return {
          content: `invalid arguments to ${def.name} — nothing was done: ${issues.join("; ")}`,
        };
      }
      return def.execute(parsed.data, context);
    },
  };
}
