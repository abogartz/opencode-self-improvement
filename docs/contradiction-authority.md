# Contradiction authority: the code check and its limits

You say the retry limit has to be `5`; the code says `3`. Before the plugin
takes sides it has to be sure it is reading a real declaration, so the check is
deliberately narrow — and what it refuses to decide is the more useful half of
this document.

The verdict table stays in the README.

## What the check will read

One thing: a unique top-level `const` with a literal value. Comments, string
examples, local declarations and computed expressions cannot establish an
authority verdict. The scan is bounded to 300 source files, 256 KiB per file
and depth 3, preferring `src/`, and it does not follow source links or resolve
imports.

Anything it cannot settle — an ambiguous declaration, unreadable or invalid
source, an exhausted budget, a claim outside its reach — keeps the plain
guidance and its staleness caveat and emits no verdict. The JavaScript/TypeScript
parser loads only when a row needs a code check; an explicit opt-out never
loads it. Use attribution keeps the stored row's identity and prose while
coverage counts only references present in the delivered text.

## The residual, accepted

A user-stated **wrong spec** still classifies as `spec`, and its verdict
follows that stated requirement even if it breaks the current tests. The plugin
does not infer a hidden test suite's authority and does not silently override
the user's requirement. Asking an oracle or inventing an extra authority class
is outside this contract.

Classification can also simply be wrong: a code comparison verifies a value
mismatch, not the user's intent.

Per the [maintainer's rollout decision](https://github.com/abogartz/opencode-self-improvement/pull/363#pullrequestreview-5819556342), the default is ON for full benchmarking after merge and can be revisited. The seat-model and merged-main confidence runs in #350–#352 remain outstanding; enabling the feature is not a claim that those benchmarks passed.
