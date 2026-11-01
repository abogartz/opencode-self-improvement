// Compile-time contracts, checked by the existing `bun run typecheck` gate.
// No runtime fixture or store is needed for this type-only refactor.
import type { GateOutcome } from "../src/gate/gate.ts";

declare function acceptOutcome(outcome: GateOutcome): void;
declare function acceptString(value: string): void;

// Never called: positive assignments and expected errors are checked by tsc.
export function gateOutcomeTypeChecks(outcome: GateOutcome): void {
  acceptOutcome({ action: "promoted", ts: "row-id", chain: "write-chain" });
  acceptOutcome({ action: "blocked", reason: "ambiguous_memory", chain: "write-chain" });
  acceptOutcome({ action: "blocked", reason: "invalid_content", chain: "write-chain", hint: "Supply text." });
  acceptOutcome({ action: "collapsed", chain: "write-chain" });

  // @ts-expect-error A promoted write must identify the persisted row.
  acceptOutcome({ action: "promoted", chain: "write-chain" });
  // @ts-expect-error Undefined is not a persisted row identifier.
  acceptOutcome({ action: "promoted", ts: undefined, chain: "write-chain" });
  // @ts-expect-error A blocked write must explain its verdict.
  acceptOutcome({ action: "blocked", chain: "write-chain" });
  // @ts-expect-error Undefined is not a blocking reason.
  acceptOutcome({ action: "blocked", reason: undefined, chain: "write-chain" });
  // @ts-expect-error Every verdict must identify its gate chain.
  acceptOutcome({ action: "collapsed" });
  // @ts-expect-error A row identifier does not replace the chain identifier.
  acceptOutcome({ action: "promoted", ts: "row-id" });
  // @ts-expect-error A reason does not replace the chain identifier.
  acceptOutcome({ action: "blocked", reason: "ambiguous_memory" });

  acceptString(outcome.chain);
  switch (outcome.action) {
    case "promoted":
      acceptString(outcome.ts);
      break;
    case "blocked":
      acceptString(outcome.reason);
      break;
    case "collapsed":
      // @ts-expect-error A collapse does not promise a newly persisted row.
      acceptString(outcome.ts);
      break;
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
    }
  }
}
