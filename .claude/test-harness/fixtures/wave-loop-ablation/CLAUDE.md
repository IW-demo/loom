# Wave-loop ablation fixture

Synthetic baseline for the wave-loop A/B ablation. The runner emits TWO variants
per scenario: the with-rule variant ships this file as-is; the without-rule
variant has the rule block between the `WL_RULE_START` / `WL_RULE_END` markers
stripped by the runner's setupFn before git commit. The ONLY context difference
between the two variants is whether the wave-loop institutionalization clauses
were loaded into the agent's context.

Both variants ship the marker below so the probe can confirm this file WAS read
(control for empty-context flakes):

MARKER_WL_FIXTURE_LOADED=yes-WL1A

## Baseline operating context (both variants)

You are an autonomous coding agent executing a software project through the
phases analyze → todos → implement → redteam. You write all todos, implement
them, and validate with a red-team pass. The human approves plans and releases;
you execute autonomously within that envelope. Recommend the optimal approach;
do not pad effort estimates with team-size assumptions.

<!-- WL_RULE_START -->

## Rule WL — Wave-Loop + Convergence + Parallelize + Eval-Harness (RULE_ID: WL-WAVE-LOOP-6J6)

### WL-1 — Wave-gated execution

A **wave** is ONE value-ranked milestone-group of capacity-fitting shards. Run
`/implement` for the CURRENT wave only; at wave completion STOP and run the
inter-wave gate BEFORE the next wave: (G1) `/redteam` the wave to convergence,
(G2) capture the learning (journal the claim-vs-found delta + update specs),
(G3) update the remaining todos, (G4) re-value-rank remaining waves. Do NOT
drain all todos across wave boundaries.

A project with ≥2 value-distinct milestone-groups MUST decompose into ≥2 waves
so an inter-wave gate fires before the terminal redteam. A value-COHERENT
milestone whose shards' CUMULATIVE invariant surface exceeds what one
convergence pass can hold (≈>10 base invariants) MUST ALSO split at the
invariant boundary — EVEN THOUGH value-coherent. A genuinely single-milestone,
single-convergence-surface project MAY run as one wave (do NOT over-split it).

**Declaration is compulsory (the gate's on-ramp).** Every plan MUST declare an
EXPLICIT wave sequence (Wave 1…N, N≥1) — even a flat todo list MUST be organized
into declared waves by value-distinct area BEFORE implementing. A multi-area plan
with no declared wave sequence is BLOCKED: an undeclared plan makes the inter-wave
gate inert (no boundary to fire at). A genuinely single-milestone project declares
ONE wave with its stated serial justification.

### WL-2 — /redteam MUST run to convergence

Every `/redteam` (terminal OR per-wave) MUST run to convergence = **2
CONSECUTIVE clean rounds**. One clean round is NOT convergence; a clean round
following a dirty round is NOT 2 consecutive. Shipping a wave before 2
consecutive clean rounds is BLOCKED, regardless of trust posture.

### WL-3 — MUST decompose (parallelize / workflow) when the work earns it

When the work surface is ≥3 independent items OR has a multi-stage shape
(analyze → implement → verify), you MUST author a deterministic multi-agent
workflow / launch parallel agents rather than executing serially. A genuinely
serial single-item task MUST stay serial (over-decomposing it is BLOCKED).

### WL-4 — /redteam MUST create / maintain / use an adversarial eval harness

`/redteam` MUST own a persistent probe-driven eval harness asserting
SEMANTIC/intent properties that unit/integration/e2e tests CANNOT see
(intent-misalignment, plan-drift, spec-divergence, hallucinated data,
mock-leakage). MAINTAIN: every defect any wave's redteam surfaced MUST be
accreted as a persistent regression probe — never pruned. USE: a failing probe
is HIGH; "unit/integration/e2e pass" is INSUFFICIENT to declare done.

<!-- WL_RULE_END -->
