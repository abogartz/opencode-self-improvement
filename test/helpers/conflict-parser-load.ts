// Separate process so a prior opt-in test cannot pre-load the parser.
import { createRequire } from "node:module";
import { selectRelevant } from "../../src/recall/relevant.ts";
import { findConstant } from "../../src/recall/conflicts.ts";
import type { Memory } from "../../src/store/model/memory.ts";

const require = createRequire(import.meta.url);
const loaded = () =>
  Object.keys(require.cache).some((path) =>
    path.replace(/\\/g, "/").includes("/@babel/parser/"),
  );
const states = [loaded()];
await selectRelevant(
  "",
  3,
  [
    {
      ts: "2026-11-08T00:00:00.000Z",
      type: "context",
      scope: "pricing",
      content: "The sales tax rate is 8.25 percent.",
      tags: ["user-guided"],
      ref: "TAX_RATE",
      claim: "0.0825",
      klass: "spec",
      file: "fixture",
      index: 0,
    } satisfies Memory,
  ],
  undefined,
  undefined,
  { guidedCap: 3 },
);
states.push(loaded());
const fact = findConstant(process.argv[2]!, "TAX_RATE");
states.push(loaded());
console.log(JSON.stringify({ states, value: fact?.value }));
