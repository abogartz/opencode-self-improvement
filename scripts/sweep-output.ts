// Bun's final failure/skip recap has no file headers. Reading it as another
// test run assigns those names to the last file and fabricates kill witnesses.
const ACL_TEST = "lock.test.ts > broken store directory (Windows ACL) > fails fast with the real error and never runs the writer";

export function testOutcomes(output: string): { passed: string[]; failed: string[]; skipped: string[]; fileFailed: string[] } {
  const result = { passed: [] as string[], failed: [] as string[], skipped: [] as string[], fileFailed: [] as string[] };
  let file = "";
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*\d+ tests? (?:failed|skipped):\s*$/.test(line)) break;
    const header = line.match(/^(?:test[/\\])?([\w.-]+\.[tj]sx?):\s*$/);
    if (header) file = header[1];
    const match = line.match(/^\s*\((pass|fail|skip)\)\s+(.*?)\s*(?:\[[^\]]*\]\s*)?$/);
    if (!match) continue;
    const [, status, name] = match;
    if (status === "fail" && /\.(test|spec)\.[tj]sx?$/.test(name) && !name.includes(" > ")) {
      result.fileFailed.push(name);
      continue;
    }
    const full = file ? `${file} > ${name}` : name;
    const into = status === "pass" ? result.passed : status === "fail" ? result.failed : result.skipped;
    if (!into.includes(full)) into.push(full);
  }
  return result;
}

// stdout and stderr may be concatenated, and concurrent files interleave.
// This fixed fixture marker identifies one specific test, never the next
// (pass) line or the last file header. Unknown/malformed diagnostics do nothing.
export function suiteAccounting(output: string) {
  const outcomes = testOutcomes(output);
  const count = (label: string): number => {
    const matches = [...output.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "gm"))];
    return Number(matches.at(-1)?.[1] ?? 0);
  };
  const rawCounts = { pass: count("pass"), fail: count("fail"), skip: count("skip") };
  let declared = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("[acl-fixture] ")) continue;
    try {
      const event = JSON.parse(line.slice("[acl-fixture] ".length));
      if (event?.event === "not-exercised" &&
        (event.reason === "acl-deny-failed" || event.reason === "denial-not-effective")) declared = true;
    } catch { /* diagnostics are not test outcomes */ }
  }
  const capabilitySkipped: string[] = [];
  // A bailout cannot erase a real failure or a file-level crash. Require an
  // observed pass and a raw pass to transfer: missing identifiers are not proof
  // of success (some Bun builds omit them). Raw counts remain available.
  if (declared && rawCounts.pass > 0 && outcomes.passed.includes(ACL_TEST) &&
    !outcomes.failed.includes(ACL_TEST) && !outcomes.fileFailed.includes("lock.test.ts")) {
    outcomes.passed = outcomes.passed.filter((name) => name !== ACL_TEST);
    if (!outcomes.skipped.includes(ACL_TEST)) outcomes.skipped.push(ACL_TEST);
    capabilitySkipped.push(ACL_TEST);
  }
  return { ...outcomes, rawCounts, capabilitySkipped,
    pass: rawCounts.pass - capabilitySkipped.length,
    fail: rawCounts.fail, skip: rawCounts.skip + capabilitySkipped.length };
}
