// The cost-claim discipline (#392), enforced rather than hoped for.
//
// Three numbers were published and corrected inside one day, because a metric
// that silently undercounts by 93% still produces a plausible number and a
// plausible number gets quoted. "Be more careful" is not a fix. These tests are
// the fix: they run in CI on every push, they cost nothing, and they fail on the
// README text itself.
//
// A review round then showed that a rule bound to one markdown format binds
// nothing: the same claim survived a leading space, a "USD" spelling, a
// "cuts token use by 30%" rewording, and a line parked one row past a fixed
// nine-line exemption. These checks match the words a claim can wear, not the
// table syntax it happens to sit in. They are word-matching, not
// evidence-checking: what still slips through is listed in the record of #392.
//
// What they hold:
//   1. the effectiveness section quotes exactly two results, each with n and
//      seat, and the reuse numbers name their estimator in words;
//   2. no dollar figure and no token-saving sentence anywhere in the README,
//      in any spelling, while explicit denials and fenced shell pass;
//   3. "cheaper" appears only where an n, a seat and a metric share the line,
//      exempting exactly the rules block that names the word;
//   4. the rules themselves are written down where a contributor reads them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const LINES = README.split("\n");

/** True for lines inside a ``` fence; the fence lines themselves count as inside. */
const FENCED = (() => {
  const out: boolean[] = [];
  let open = false;
  for (const line of LINES) {
    if (line.trimStart().startsWith("```")) {
      open = !open;
      out.push(true);
      continue;
    }
    out.push(open);
  }
  return out;
})();

/** The section's own lines, up to the next `## ` heading. */
function section(heading: string): string[] {
  const start = LINES.findIndex((l) => l.startsWith(heading));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of LINES.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    out.push(line);
  }
  return out;
}

const WORTH = section("## What memory is worth, measured");

describe("the effectiveness section quotes exactly two results", () => {
  test("the section exists", () => {
    expect(WORTH.length).toBeGreaterThan(5);
  });

  test("transport: floor and seeded result, with n", () => {
    const text = WORTH.join("\n");
    expect(text).toContain("Transport");
    expect(text).toContain("0/5");
    expect(text).toContain("5/5");
    expect(text).toContain("5 per arm");
    // The floor is the result. A transport claim without it is not transport.
    expect(text.toLowerCase()).toContain("empty store");
  });

  test("reuse: the neutral median-of-ratios, with n and its estimator", () => {
    const text = WORTH.join("\n");
    expect(text).toContain("Reuse");
    expect(text).toContain("0.91");
    expect(text).toContain("6 pairs");
    expect(text).toContain("0.99");
    // The first version published ratios[Math.floor(n/2)] — the upper-middle
    // element at n=6 — as "the median", and a bare "median" cannot tell a
    // reader between median-of-ratios and ratio-of-medians. The estimator is
    // pinned in words so the mislabel cannot come back.
    expect(text).toMatch(/median of the six per-pair/);
    expect(text).toMatch(/middle two/);
  });

  test("the seat is named inside the section", () => {
    // Without a seat these are adjectives, not measurements.
    expect(WORTH.join("\n")).toMatch(/evo\/[A-Za-z0-9.\-_]+/);
  });

  test("exactly two result rows — a third claim has to move this test first", () => {
    const rows = WORTH.filter((l) =>
      /^\|\s*\*\*(Transport|Reuse)\.\*\*/.test(l.trimStart()),
    );
    expect(rows.length).toBe(2);
    // Claim-shaped content, not markdown syntax: a table row survives a leading
    // space or a `|-` prefix, and a third result smuggled in as a bold
    // paragraph is just as much a third result. Only the section's own
    // scaffolding paragraphs are exempt.
    const scaffolding = [
      /^\*\*The metric\.\*\*/,
      /^\*\*What is not claimed here\.\*\*/,
    ];
    const claimShaped = WORTH.filter((l) => {
      const t = l.trimStart();
      // A table row that is not a separator: separators hold only | : - and space.
      if (/^\|/.test(t) && !/^\|[\s:|-]+$/.test(t)) return true;
      if (/^\*\*[^*]+\.\*\*/.test(t) && !scaffolding.some((r) => r.test(t)))
        return true;
      return false;
    });
    // The table header plus the two results. Nothing else.
    expect(claimShaped.length).toBe(3);
  });
});

describe("no cost claim the corrected metric cannot support", () => {
  test("no dollar figure anywhere in the README", () => {
    // A local seat has no cache price. Any dollar figure in this file is either
    // hosted-provider-measured (none exists) or invented. The word spellings
    // count too — "1.20 USD", "two dollars" and "＄5" are dollar figures —
    // while fenced code (a shell `$1`) and an explicit denial of money are not.
    const money = /\$\s?\d|＄\s?\d|\bUSD\b|\bdollars?\b|\bcents?\b/i;
    const denial = /\bno\b[^.]*\bdollar|\bnot\b[^.]*\bdollar|\bno\b[^.]*\bUSD/i;
    const hits = LINES.filter(
      (l, i) => !FENCED[i] && money.test(l) && !denial.test(l),
    );
    expect(hits).toEqual([]);
  });

  test("no sentence asserts a token saving", () => {
    // Every phrasing a saving claim can wear, on one line or split across a
    // bullet and its sub-bullets: "30% fewer tokens", "30% reduction in
    // tokens", "2× fewer tokens", "cuts token use by 30%", "saves an estimated
    // 1,000 tokens", "1,000 tokens avoided". An explicit denial ("No tokens
    // saved here.") states the rule, not a claim, and passes.
    const saving =
      /(?:\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s*×)\s*(?:fewer|less|cheaper|reduction|drop|saving)s?\b[^.]{0,20}\btokens?\b|(?:cuts?|reduces?|lowers?|drops?|saves?)\b[^.]{0,40}\btokens?\b[^.]{0,20}\bby\s+\d|saves?\b[^.]{0,40}[\d,.]+\s+tokens?\b|tokens?\s+(?:saved|reduced|avoided|eliminated)/i;
    const negation = /\b(?:no|not|never|zero)\b/i;
    const hits: string[] = [];
    const indentOf = (l: string) => l.length - l.trimStart().length;
    LINES.forEach((line, i) => {
      if (FENCED[i]) return;
      let text = line;
      const indent = indentOf(line);
      for (let j = i + 1; j < LINES.length && !FENCED[j]; j++) {
        if (LINES[j].trim() === "") break;
        if (indentOf(LINES[j]) <= indent) break;
        text += " " + LINES[j];
      }
      const m = text.match(saving);
      if (m && !negation.test(text.slice(0, m.index)))
        hits.push(`${i + 1}: ${line.slice(0, 90)}`);
    });
    expect(hits).toEqual([]);
  });

  test("a percentage is never attached to tokens without saying bytes", () => {
    // "12.3% fewer characters" is a byte measurement and must stay labelled as
    // one: bytes on a deterministic workload are not tokens and not a bill.
    const hits = LINES.filter(
      (l) =>
        /\d+(?:\.\d+)?%\s*(?:fewer|less)\b/.test(l) &&
        /token/i.test(l) &&
        !/not tokens|bytes/i.test(l),
    );
    expect(hits).toEqual([]);
  });
});

describe("the word cheaper carries its evidence", () => {
  // The rules list is allowed to NAME the words it bans; that is the only
  // exemption, and it is bounded by the rules block's own extent — the heading
  // plus the bullet block that follows it — so a line parked just past the
  // block cannot hide in a fixed nine-line window.
  const rulesStart = LINES.findIndex((l) =>
    l.includes("**Rules for any cost claim"),
  );

  function rulesBlockEnd(start: number): number {
    let i = start + 1;
    while (i < LINES.length && LINES[i].trim() === "") i++;
    let end = i - 1;
    while (i < LINES.length && LINES[i].trim() !== "") {
      end = i;
      i++;
    }
    return end;
  }

  test("the rules list exists, so the exemption has an anchor", () => {
    expect(rulesStart).toBeGreaterThan(0);
  });

  test("every other line with 'cheaper' names an n, a seat and a metric", () => {
    const blockEnd = rulesBlockEnd(rulesStart);
    const offenders: string[] = [];
    LINES.forEach((line, i) => {
      if (!/cheaper/i.test(line)) return;
      if (i >= rulesStart && i <= blockEnd) return;
      const hasN = /\bn\s*[=≥>]\s*\d|n=\d+\s*pairs|\dn\b.{0,20}pairs/i.test(
        line,
      );
      const hasSeat = /seat|evo\/|llama|hosted provider/i.test(line);
      const hasMetric = /work\s*=|generation|uncached|cache read|metric/i.test(
        line,
      );
      if (!(hasN && hasSeat && hasMetric))
        offenders.push(`${i + 1}: ${line.slice(0, 90)}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe("the rules are written down where contributors hit them", () => {
  test("the n floor is stated", () => {
    expect(WORTH.join("\n")).toMatch(/n=6 pairs per arm|n\s*=\s*6 pairs/);
  });

  test("the resolution label is stated on the row it qualifies", () => {
    // Pinned to the result row: the label may not survive only in the rules
    // bullet while the row quietly becomes "10% resolution".
    const reuseRow = WORTH.find((l) => /^\|\s*\*\*Reuse\.\*\*/.test(l)) ?? "";
    expect(reuseRow).toContain("20% resolution");
  });

  test("the rules reach issue and PR bodies, where CI cannot read them", () => {
    expect(WORTH.join("\n")).toContain(
      "An issue or PR body making a cost claim owes the same n, seat and metric",
    );
  });

  test("cache state is named as a confounder, because that is what produced the worst claim", () => {
    // #365's 20,506 -> 10,009 "saving" was two runs in different cache states.
    expect(WORTH.join("\n").toLowerCase()).toContain("cache state");
  });

  test("the corrected metric is defined in words, not implied", () => {
    expect(WORTH.join("\n")).toContain(
      "session generation + capture generation",
    );
  });
});
