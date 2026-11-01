// extractCallForms guards: prose parentheses and file references must NOT
// parse as code call signatures. Without the guards, `package.json(committed
// by @semantic-release/git…)` and `ctx.session.context (main-agent review
// fix)` read as calls to `json` and `context`, get drift-compared against
// live code, and block legitimate memory writes with drift_ref_stale_incoming.
import { describe, expect, test } from "bun:test";
import { extractCallForms } from "../src/gate/resolver.ts";

describe("extractCallForms — prose and file-reference guards", () => {
  test("file reference followed by parenthetical prose is not a call", () => {
    expect(
      extractCallForms("version bumped in package.json(committed by @semantic-release/git with [skip ci])"),
    ).toEqual([]);
    expect(extractCallForms("add a plugin entry to opencode.json(c) for loading")).toEqual([]);
    expect(extractCallForms("config.logfmt(see exports) lives outside repos")).toEqual([]);
  });

  test("dotted name followed by multi-word prose parens is not a call", () => {
    expect(
      extractCallForms("never detach ctx.session.context (main-agent review fix) from its receiver"),
    ).toEqual([]);
    expect(
      extractCallForms("the fakes are closures but real.session.context (client may bind this) differs"),
    ).toEqual([]);
  });

  test("genuine code call forms still extract", () => {
    let forms = extractCallForms("harness.runInit({ force: true }) re-indexes the graph");
    expect(forms.length).toBe(1);
    expect(forms[0].name).toBe("runInit");

    forms = extractCallForms("call ctx.session.context({ sessionID: sid }) first");
    expect(forms.length).toBe(1);
    expect(forms[0].symbol).toBe("ctx.session.context");

    forms = extractCallForms("BABYLON.MeshBuilder.CreateBox(name, options, scene)");
    expect(forms.length).toBe(1);

    forms = extractCallForms("single identifier arg: state.foo(sessionID)");
    expect(forms.length).toBe(1);
  });
});
