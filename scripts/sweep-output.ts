// Bun's final failure/skip recap has no file headers. Reading it as another
// test run assigns those names to the last file and fabricates kill witnesses.
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
