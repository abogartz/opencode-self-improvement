// Memory tool registration (#168): one module per tool, registered here in
// the same order index.ts used before the split. Behavior, schemas and result
// shapes are pinned by the e2e characterization suite (#241) and the
// registration coverage gate (e2e/coverage.test.ts).
import { register as registerRemember } from "./remember.ts";
import { register as registerConsolidate } from "./consolidate.ts";
import { register as registerInit } from "./init.ts";
import { register as registerRecall } from "./recall.ts";
import { register as registerUpdate } from "./update.ts";
import { register as registerForget } from "./forget.ts";
import { register as registerList } from "./list.ts";
import { register as registerUndo } from "./undo.ts";
import { register as registerEvidence } from "./evidence.ts";
import { register as registerMergeReview } from "./merge-review.ts";
import { register as registerExport } from "./export.ts";
import { register as registerImport } from "./import.ts";
import { register as registerDecay } from "./decay.ts";
import { register as registerStatus } from "./status-tool.ts";
import type { ToolDeps, ToolEditorLike } from "./deps.ts";

export function registerMemoryTools(editor: ToolEditorLike, deps: ToolDeps): void {
  for (const register of [
    registerRemember,
    registerConsolidate,
    registerInit,
    registerRecall,
    registerUpdate,
    registerForget,
    registerList,
    registerUndo,
    registerEvidence,
    registerMergeReview,
    registerExport,
    registerImport,
    registerDecay,
    registerStatus,
  ]) {
    register(editor, deps);
  }
}
