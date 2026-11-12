// Contract (#393): a row the plugin cannot verify does not reach the model as a
// bare fact. Either it was checked, or it arrives carrying the reason to discount
// it.
//
// The evidence that set the scope (R4, `results-poison-x5/`, n=5): an empty store
// produced no artifact in 3/5 runs and never invented a rate; ONE plausible wrong
// row shipped a WRONG artifact in 4/5 (2475, 2100, 3100, 1750) with no uncertainty
// flagged; the correct row was 5/5. A false row converts "I cannot proceed" into
// "I shipped something wrong".
//
// And the measurement that set the LIMIT: the poison filled a gap the tree left
// open — `findConstant(base4, "fallbackVatBps")` is null, because the fixture
// leaves the value unset. So a contradiction check cannot catch it, and a
// silence-is-suspicion check would also refuse the transport fact (0/5 empty, 5/5
// seeded). What ships is the label plus a check that only ever refuses on a real
// contradiction.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetCaptureCooldowns, resetSessionModels } from "../src/index.ts";
import { formatMemory } from "../src/inject/format.ts";
import {
  claimVerdict,
  claimVerdictFromContent,
  type ClaimVerdict,
} from "../src/capture/checked.ts";
import {
  provenanceMarker,
  provenanceOf,
} from "../src/store/model/provenance.ts";
import { loadAll } from "../src/store/files/load.ts";
import { type Memory } from "../src/store/model/memory.ts";
import { loadPlugin, withTempStore } from "./harness.ts";
import { readEvidenceLog } from "./helpers/logfmt.ts";

const row = (tags: string[] | undefined): Memory =>
  ({
    ts: "2026-10-01T09:00:00.000Z",
    type: "context",
    scope: "config",
    content: "The site fallback VAT rate is 2475 basis points.",
    status: "settled",
    ...(tags ? { tags } : {}),
  }) as unknown as Memory;

describe("provenance is derived, and total", () => {
  test("each class is named", () => {
    expect(provenanceOf(["user-guided", "auto-capture"]).kind).toBe(
      "user-stated",
    );
    expect(provenanceOf(["auto-capture"]).kind).toBe("capture-inferred");
    expect(provenanceOf(["import"]).kind).toBe("imported");
    expect(provenanceOf(undefined).kind).toBe("elicited");
  });

  test("nothing falls through, because the real store cannot afford it", () => {
    // Measured on the live store on 2026-11-11: of 1014 rows, 109 carry
    // `auto-capture`, 18 carry `user-guided`, 0 carry `import`, and 905 carry
    // none of those — they came through the tool path. A rule that refused to
    // inject "a row with no provenance" would have dropped 89% of the store.
    // That is a recall loss wearing a safety badge, so the derivation is total
    // and this test is the guard against "simplifying" it into a filter.
    const shapes: (string[] | undefined)[] = [
      undefined,
      [],
      ["build"],
      ["user-guided"],
      ["auto-capture"],
      ["import"],
      ["auto-capture", "code-checked"],
    ];
    expect(shapes.every((t) => provenanceOf(t) !== null)).toBe(true);
  });

  test("only an inference that was never checked is marked unverified", () => {
    expect(provenanceMarker(provenanceOf(["auto-capture"]))).toBe(
      " [unverified]",
    );
    expect(
      provenanceMarker(provenanceOf(["auto-capture", "code-checked"])),
    ).toBe(" [code-checked]");
    // The user's own authority in this repo renders nothing. Decorating 905 of
    // 1014 rows with a warning would teach the model to ignore the warning.
    expect(provenanceMarker(provenanceOf(undefined))).toBe("");
    expect(provenanceMarker(provenanceOf(["user-guided"]))).toBe("");
  });
});

describe("provenance survives injection", () => {
  test("formatMemory renders the marker, and keeps the existing [via …] text", () => {
    const mined = formatMemory(row(["auto-capture"]));
    expect(mined).toContain("[via auto-capture]");
    expect(mined).toContain("[unverified]");
    expect(formatMemory(row(["auto-capture", "code-checked"]))).toContain(
      "[code-checked]",
    );
    expect(formatMemory(row(undefined))).not.toContain("unverified");
  });

  test("AC 5: the marker costs bytes, and the cost is named exactly", () => {
    // "Nothing in this ticket lengthens existing rows" is read as: the added
    // bytes are metadata, bounded, and reported. 13 chars per unverified row.
    const after = formatMemory(row(["auto-capture"]));
    // The marker alone. `[via auto-capture]` already shipped and is not this
    // ticket's cost.
    expect(after.length - after.replace(" [unverified]", "").length).toBe(
      " [unverified]".length,
    );
    // What it can cost an actual request: the relevance block carries at most 5
    // rows plus 3 guided rows, so the ceiling is 8 markers against a 1200-char
    // budget. That is the number #393 AC 5 asks for, not the store-wide one.
    const ceiling = 8 * " [unverified]".length;
    expect(ceiling).toBe(104);
    expect(ceiling / 1200).toBeLessThan(0.09);
  });
});

describe("claimVerdict", () => {
  const fixture = withTempStore({ prefix: "osi-claim-" });

  function makeTree(): string {
    const dir = join(fixture.root, "tree");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "config.ts"),
      "export const VAT_BPS = 2150;\n",
    );
    return dir;
  }

  test("an inferred claim that agrees with the tree is marked, not refused", () => {
    expect(claimVerdict(makeTree(), "VAT_BPS", "2150")).toBe("agrees");
  });

  test("an inferred claim the tree contradicts is the only refusal", () => {
    expect(claimVerdict(makeTree(), "VAT_BPS", "2475")).toBe("contradicts");
  });

  test("a tree that is silent is undecidable, and that is the transport case", () => {
    // base4 leaves the rate unset on purpose: it is the fact the harness holds
    // and the repository never contains. Refusing here is refusing transport.
    expect(claimVerdict(makeTree(), "FALLBACK_NOT_DECLARED", "2150")).toBe(
      "undecidable",
    );
    expect(claimVerdict(undefined, "VAT_BPS", "2150")).toBe("undecidable");
  });
});

const fixture = withTempStore({ prefix: "osi-prov-capture-" });

describe("capture checks an inferred claim before storing it", () => {
  let plugin: Awaited<ReturnType<typeof loadPlugin>> | undefined;

  beforeEach(() => {
    resetCaptureCooldowns();
    resetSessionModels();
  });
  afterEach(async () => {
    await plugin?.cleanup();
    plugin = undefined;
  });

  async function run(candidates: unknown[], sid: string): Promise<void> {
    const repo = join(fixture.root, `repo-${sid}`);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "config.ts"),
      "export const VAT_BPS = 2150;\n",
    );
    plugin = await loadPlugin(repo, {
      autoCapture: true,
      captureModel: "fake/model",
    });
    await plugin["tool.execute.after"](
      {
        tool: "read",
        sessionID: sid,
        callID: "read",
        args: { filePath: "src/config.ts" },
      },
      { output: "export const VAT_BPS = 2150;", metadata: {} },
    );
    plugin.capture.context.messages = [
      {
        role: "user",
        content:
          `Check the customs rating path and the filing output. The site VAT constant lives in src/config.ts as VAT_BPS. ` +
          `Confirm the kiosk order path has no tax class and write the declaration file, then run the suite.`.repeat(
            2,
          ),
      },
    ];
    plugin.capture.generate.response = JSON.stringify(candidates);
    plugin.capture.events.push({
      type: "session.execution.succeeded",
      data: { sessionID: sid },
    });
    const deadline = Date.now() + 4000;
    while (!readEvidenceLog().some((l) => String(l.session) === sid)) {
      if (Date.now() > deadline) throw new Error("capture did not run");
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  test("a contradicted inferred claim is refused and the failed check is logged", async () => {
    await run(
      [
        {
          type: "context",
          scope: "poison",
          content: "The VAT_BPS constant for this site is 2475 basis points.",
        },
      ],
      "ses-contradict",
    );
    const line = readEvidenceLog().find(
      (l) => l.ev === "auto_capture_contradiction",
    );
    expect(line).toBeDefined();
    expect(String(line?.reason)).toBe("claim_contradicts_tree");
    expect(String(line?.where)).toBe("VAT_BPS");
    expect((await loadAll()).filter((m) => m.scope === "poison").length).toBe(
      0,
    );
  });

  test("a claim that agrees is stored and tagged code-checked, so injection drops the warning", async () => {
    await run(
      [
        {
          type: "context",
          scope: "agreed",
          content: "The VAT_BPS constant for this site is 2150 basis points.",
        },
      ],
      "ses-agree",
    );
    const stored = (await loadAll()).filter((m) => m.scope === "agreed");
    expect(stored.length).toBe(1);
    expect(stored[0]?.tags ?? []).toContain("code-checked");
    expect(formatMemory(stored[0]!)).toContain("[code-checked]");
  });

  test("an undecidable inferred claim is still stored — transport must survive", async () => {
    await run(
      [
        {
          type: "context",
          scope: "transport",
          content:
            "Finance confirmed this site's fallback is 2150 basis points for unclassed kiosk orders.",
        },
      ],
      "ses-transport",
    );
    const stored = (await loadAll()).filter((m) => m.scope === "transport");
    expect(stored.length).toBe(1);
    // Stored, and labelled for what it is: nothing outside the transcript vouched
    // for it, and the row says so where the model will read it.
    expect(formatMemory(stored[0]!)).toContain("[unverified]");
  });

  test("a user-stated claim is never sent through the inferred-claim check", async () => {
    // The user correcting a stale value is the case the check must NOT touch:
    // the tree is the thing that may be wrong.
    await run(
      [
        {
          type: "context",
          scope: "corrected",
          content:
            "VAT_BPS is wrong in the tree; the rate is 2475 basis points now.",
          guided: true,
        },
      ],
      "ses-guided",
    );
    expect(
      readEvidenceLog().some((l) => l.ev === "auto_capture_contradiction"),
    ).toBe(false);
    expect(
      (await loadAll()).filter((m) => m.scope === "corrected").length,
    ).toBe(1);
  });

  test("the accepted cost: a row whose only near number is not the value is refused", async () => {
    // Named rather than hidden. The check compares every number within 48 chars
    // of a symbol it resolved, so a row that mentions the constant and an
    // unrelated number ("changed in 2024") is refused as a contradiction. The
    // alternative — refusing nothing at all — is the state R4 measured as harm.
    // If this starts firing on real rows, widen the rule here, not silently.
    await run(
      [
        {
          type: "learning",
          scope: "history",
          content: "VAT_BPS was introduced in 2024 and has not moved since.",
        },
      ],
      "ses-coincide",
    );
    expect(
      readEvidenceLog().some((l) => l.ev === "auto_capture_contradiction"),
    ).toBe(true);
    expect((await loadAll()).filter((m) => m.scope === "history").length).toBe(
      0,
    );
  });

  test("a sign survives extraction: -2150 contradicts a tree declaring 2150", () => {
    // Review finding (PR #399): the unsigned match passed "2150" to valuesAgree
    // for a row saying "-2150", so an opposite-signed value was positively
    // labelled [code-checked]. Agreement must be earned by the number the row
    // actually states.
    const dir = join(fixture.root, "sign-tree");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "config.ts"),
      "export const VAT_BPS = 2150;\n",
    );
    expect(
      claimVerdictFromContent(
        dir,
        "The VAT_BPS constant for this site is -2150 basis points.",
      ).verdict,
    ).toBe("contradicts");
    // Structured control from the review: same verdict through the declared-ref
    // form, proving the loss was specific to the prose extractor.
    expect(claimVerdict(dir, "VAT_BPS", "-2150")).toBe("contradicts");
    // A spaced hyphen is a separator, not a sign.
    expect(
      claimVerdictFromContent(
        dir,
        "The VAT_BPS constant is 2150 - a later discount aside.",
      ).verdict,
    ).toBe("agrees");
  });

  test("the verdict does not depend on which row was checked last", () => {
    // A module-level `g` regex carries lastIndex between calls. The first
    // version of this check had one, and a claim was "undecidable" purely
    // because an earlier row had consumed part of the pattern's state — a gate
    // whose answer depends on call order looks deterministic and is not.
    const dir = join(fixture.root, "order-tree");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "config.ts"),
      "export const VAT_BPS = 2150;\n",
    );
    const agree = "The VAT_BPS constant for this site is 2150 basis points.";
    const bad = "The VAT_BPS constant for this site is 2475 basis points.";
    expect(claimVerdictFromContent(dir, bad).verdict).toBe("contradicts");
    expect(claimVerdictFromContent(dir, agree).verdict).toBe("agrees");
    expect(claimVerdictFromContent(dir, bad).verdict).toBe("contradicts");
    expect(claimVerdictFromContent(dir, agree).verdict).toBe("agrees");
  });

  test("the verdict type has exactly the three outcomes the design allows", () => {
    const all: ClaimVerdict[] = ["agrees", "contradicts", "undecidable"];
    expect(all.length).toBe(3);
  });
});
