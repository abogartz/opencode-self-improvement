import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bracketList,
  formatLine,
  parseLine,
} from "../src/core/logfmt/format.ts";
import {
  type Fake,
  loadFailure,
  makeGuest,
  REPO,
  startFake,
  turn,
} from "./support/harness.ts";
import {
  FOOTER,
  type Formatter,
  type FormatterTrace,
} from "./support/pull-formatter-plugin/index.ts";

const FORMATTER = join(import.meta.dir, "support", "pull-formatter-plugin");
const DAY = "2026-11-19";
const CUE = "ERR_MODULE_NOT_FOUND vite.config.ts";
const FILENAME = "notes-8817.txt";
const PROMPT = `E2E::matrix inspect ${FILENAME}`;
const CALL_ID = "read-pull-462";
const DONE = "PULL-ATTRIBUTION-DONE";
const KEPT = {
  ts: `${DAY}T10:00:02.000Z`,
  content: `${CUE} PULL-KEPT-462 requires a clean checkout.`,
};
const CLIPPED = {
  ts: `${DAY}T10:00:01.000Z`,
  content: `${CUE} PULL-CLIPPED-462 requires an offline package cache.`,
};
type Row = typeof KEPT;
const SAME_TEXT = { ...KEPT, ts: CLIPPED.ts };

interface ProviderMessage {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string } }>;
}

interface Scenario {
  name: string;
  formatter?: Formatter;
  order?: "before" | "after";
  rows: Row[];
  delivered: Row[];
  credited?: Row[];
}

const scenarios: Scenario[] = [
  { name: "memory alone", rows: [KEPT], delivered: [KEPT] },
  {
    name: "200-character limiter before memory",
    formatter: "limit",
    order: "before",
    rows: [KEPT],
    delivered: [KEPT],
  },
  {
    name: "200-character limiter after memory",
    formatter: "limit",
    order: "after",
    rows: [KEPT],
    delivered: [],
  },
  {
    name: "footer before memory",
    formatter: "footer",
    order: "before",
    rows: [KEPT],
    delivered: [KEPT],
  },
  {
    name: "footer after memory",
    formatter: "footer",
    order: "after",
    rows: [KEPT],
    delivered: [KEPT],
  },
  {
    name: "formatter clips the second of two rows",
    formatter: "clip",
    order: "after",
    rows: [KEPT, CLIPPED],
    delivered: [KEPT],
  },
  {
    name: "both identical rendered lines survive",
    rows: [KEPT, SAME_TEXT],
    delivered: [KEPT, SAME_TEXT],
  },
  {
    name: "repeating a clipped pair inside one tool result leaves its row IDs ambiguous",
    formatter: "repeat-clip",
    order: "after",
    rows: [KEPT, SAME_TEXT],
    delivered: [KEPT, KEPT],
    credited: [],
  },
  {
    name: "one identical line survives but its row ID is ambiguous",
    formatter: "clip",
    order: "after",
    rows: [KEPT, SAME_TEXT],
    delivered: [KEPT],
    credited: [],
  },
];

let fake: Fake;
beforeAll(async () => {
  fake = await startFake();
});
afterAll(() => fake.stop());

function memoryLine(row: Row): string {
  return `- [${DAY}] learning/fixture: ${row.content}`;
}

function completeLines(text: string, rows: Row[]): string[] {
  const expected = rows.map(memoryLine);
  return text.split(/\r?\n/).filter((line) => expected.includes(line));
}

test.each(scenarios)(
  "#462 pull attribution: $name",
  async ({ formatter, order, rows, delivered, credited = delivered }) => {
    const guest =
      order === "before"
        ? makeGuest(fake, FORMATTER, [REPO])
        : makeGuest(fake, REPO, formatter ? [FORMATTER] : []);
    try {
      const tracePath = join(guest.root, "formatter.json");
      if (formatter) {
        guest.env.E2E_PULL_FORMATTER = formatter;
        guest.env.E2E_PULL_FORMATTER_TRACE = tracePath;
      }
      writeFileSync(
        join(guest.memoryDir, `${DAY}.logfmt`),
        `${rows
          .map((row) =>
            formatLine({
              ...row,
              type: "learning",
              scope: "fixture",
              repo: "global",
              status: "settled",
            }),
          )
          .join("\n")}\n`,
      );
      const path = join(guest.projDir, FILENAME);
      // Only the read output has the cue. Its original text exceeds 200 chars.
      writeFileSync(path, `${CUE}\n${"padding ".repeat(40)}\n`);

      fake.setSteps({
        [PROMPT]: [
          {
            tool_calls: [
              {
                id: CALL_ID,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) },
              },
            ],
          },
          { content: DONE },
        ],
      });
      const run = await turn(fake, guest, PROMPT);
      expect(loadFailure(run)).toBeUndefined();
      expect(run.text()).toContain(DONE);
      expect(
        run.toolUses.map(({ tool, status }) => ({ tool, status })),
      ).toEqual([{ tool: "read", status: "completed" }]);
      const readEvent = run.events.find(
        (event) => event.type === "tool_use" && event.part.tool === "read",
      );
      const sid: string = readEvent?.sessionID;
      expect(sid).toMatch(/^ses_/);
      expect(readEvent?.part.id).toBe(CALL_ID);

      const requests: ProviderMessage[][] = (await fake.requests())
        .filter((body) => body.tools?.length)
        .map((body) => body.messages)
        .filter((messages: ProviderMessage[]) =>
          messages.some(
            (m) =>
              m.role === "user" &&
              (m.content === PROMPT || m.content === JSON.stringify(PROMPT)),
          ),
        );
      expect(requests).toHaveLength(2);
      expect(requests[0].some((m) => m.role === "tool")).toBe(false);
      expect(
        requests[1].some(
          (m) =>
            m.role === "assistant" &&
            m.tool_calls?.some(
              (call) => call.id === CALL_ID && call.function.name === "read",
            ),
        ),
      ).toBe(true);
      const results = requests[1].filter((m) => m.role === "tool");
      expect(results.map((m) => m.tool_call_id)).toEqual([CALL_ID]);
      const wire = results[0].content ?? "";
      expect(wire).toContain(CUE);
      // The only copy the primary model sees must be on this exact tool result.
      for (const message of [...requests[0], ...requests[1]].filter(
        (m) => m.role !== "tool",
      )) {
        for (const row of rows)
          expect(message.content ?? "").not.toContain(row.content);
      }
      expect(completeLines(wire, rows)).toEqual(delivered.map(memoryLine));

      if (formatter) {
        const trace: FormatterTrace = JSON.parse(
          readFileSync(tracePath, "utf8"),
        );
        expect(trace).toMatchObject({ sid, callID: CALL_ID });
        expect(completeLines(trace.before, rows)).toEqual(
          order === "before" ? [] : rows.map(memoryLine),
        );
        if (formatter === "limit") {
          expect(trace.before.length).toBeGreaterThan(200);
          expect(trace.after).toBe(trace.before.slice(0, 200));
          if (order === "after") expect(wire).toBe(trace.after);
        } else if (formatter === "footer") {
          expect(trace.after).toBe(`${trace.before}\n${FOOTER}`);
          expect(wire).toContain(FOOTER);
        } else {
          const clipped = trace.before.slice(0, -8);
          expect(trace.after).toBe(
            formatter === "repeat-clip" ? clipped + "\n" + clipped : clipped,
          );
          expect(wire).toBe(trace.after);
          // It is possible for a marker to survive even when its row does not.
          expect(wire).toContain(rows[1].content.slice(0, -8));
        }
      }

      const ledgerPath = join(guest.memoryDir, "hits.logfmt");
      const ledger = existsSync(ledgerPath)
        ? readFileSync(ledgerPath, "utf8")
        : "";
      const receipts = ledger
        .split("\n")
        .map(parseLine)
        .filter((receipt) => receipt?.src === "pull")
        .map((receipt) => ({
          ev: receipt?.ev,
          sid: receipt?.sid,
          mem: receipt?.mem,
        }));
      const ids = credited.map((row) => row.ts);
      expect(
        receipts,
        `session ${sid}, tool call ${CALL_ID}: expected attributable IDs ${bracketList(ids)}`,
      ).toEqual(
        ids.length ? [{ ev: "memory_used", sid, mem: bracketList(ids) }] : [],
      );
    } finally {
      rmSync(guest.root, { recursive: true, force: true });
    }
  },
  240_000,
);
