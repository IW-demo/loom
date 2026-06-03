#!/usr/bin/env node
/*
 * F101-1 — canonical provenance-event schema (loom#411, governance-as-DNA loom lane).
 *
 * loom owns the event FORMAT (the loom↔csq seam: a loom-captured event MUST be byte-exact
 * with what csq signs). These tests pin the load-bearing invariants of
 * .claude/hooks/lib/provenance-event.js:
 *   1. closed taxonomy {HumanInput|Action|Decision|Delegation}
 *   2. operator_ref carries identity ONLY — a model/API key field is REJECTED
 *      (#411 signing-vs-model-key separation)
 *   3. byte-exact canonical form (determinism across key-insertion order)
 *   4. prev_link chaining (genesis null → hash → hash)
 *   5. required-field + closed-shape validation
 *
 * Run: node --test .claude/test-harness/tests/provenance-event.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pe = require("../../hooks/lib/provenance-event.js");
const {
  EVENT_KINDS,
  SCHEMA_VERSION,
  validateProvenanceEvent,
  buildProvenanceEvent,
  hashProvenanceEvent,
  chainProvenanceEvent,
} = pe;

const OP = { verified_id: "548FABCD", person_id: "pid-example-10e7dd16" };
const TS = "2026-06-01T00:00:00Z";

function baseArgs(overrides = {}) {
  return {
    kind: "HumanInput",
    ts: TS,
    session: "sess-1",
    operatorRef: { ...OP },
    payload: { text: "use short-lived tokens" },
    ...overrides,
  };
}

test("buildProvenanceEvent produces a valid frozen event with all kinds", () => {
  for (const kind of EVENT_KINDS) {
    const evt = buildProvenanceEvent(baseArgs({ kind }));
    assert.equal(evt.kind, kind);
    assert.equal(evt.schema_version, SCHEMA_VERSION);
    assert.equal(evt.prev_link, null, "genesis prev_link defaults to null");
    assert.ok(Object.isFrozen(evt), "event is frozen");
    assert.deepEqual(validateProvenanceEvent(evt), { ok: true, errors: [] });
  }
});

test("closed taxonomy — an unknown kind is rejected", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ kind: "ReadPath" })), /kind MUST be one of/);
  const bad = { ...buildProvenanceEvent(baseArgs()), kind: "Mutation" };
  assert.equal(validateProvenanceEvent(bad).ok, false);
});

test("operator_ref carries identity ONLY — a model key is rejected (#411)", () => {
  // the exact failure mode the identity correction forbids: a model/api key on operator_ref
  assert.throws(
    () => buildProvenanceEvent(baseArgs({ operatorRef: { ...OP, model_key: "sk-shared-gcp" } })),
    /not an allowed field|signing-vs-model-key/,
  );
  assert.throws(
    () => buildProvenanceEvent(baseArgs({ operatorRef: { ...OP, api_key: "x" } })),
    /not an allowed field/,
  );
  // display_id IS allowed (optional)
  const ok = buildProvenanceEvent(baseArgs({ operatorRef: { ...OP, display_id: "example" } }));
  assert.equal(ok.operator_ref.display_id, "example");
});

test("operator_ref missing verified_id / person_id is rejected", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ operatorRef: { verified_id: "x" } })), /person_id/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ operatorRef: { person_id: "x" } })), /verified_id/);
});

test("byte-exact canonical form — key insertion order does not change the hash", () => {
  const a = buildProvenanceEvent(baseArgs());
  // build a structurally identical event with operator_ref keys in reversed order
  const b = buildProvenanceEvent(
    baseArgs({ operatorRef: { person_id: OP.person_id, verified_id: OP.verified_id } }),
  );
  assert.equal(hashProvenanceEvent(a), hashProvenanceEvent(b), "hash is order-independent");
});

test("prev_link chaining — genesis null → hash → hash", () => {
  const genesis = chainProvenanceEvent(null, baseArgs({ kind: "HumanInput" }));
  assert.equal(genesis.prev_link, null);

  const second = chainProvenanceEvent(genesis, baseArgs({ kind: "Decision", payload: { d: "15m expiry" } }));
  assert.equal(second.prev_link, hashProvenanceEvent(genesis), "second links to genesis hash");
  assert.match(second.prev_link, /^[0-9a-f]{64}$/);

  const third = chainProvenanceEvent(second, baseArgs({ kind: "Action", payload: { tool: "Edit" } }));
  assert.equal(third.prev_link, hashProvenanceEvent(second));
  // tamper genesis → second's stored prev_link no longer matches a recomputed hash
  const tampered = { ...genesis, payload: { text: "TAMPERED" } };
  assert.notEqual(second.prev_link, hashProvenanceEvent(tampered), "chain detects tamper");
});

test("prev_link must be null or sha256 hex", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ prevLink: "not-a-hash" })), /prev_link MUST be/);
  const okHex = "a".repeat(64);
  assert.equal(buildProvenanceEvent(baseArgs({ prevLink: okHex })).prev_link, okHex);
});

test("closed top-level shape — an extraneous key is rejected", () => {
  const evt = buildProvenanceEvent(baseArgs());
  assert.equal(validateProvenanceEvent({ ...evt, rogue: 1 }).ok, false);
});

test("non-canonical-serializable payload is rejected (NaN / Infinity)", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { n: NaN } })), /.*/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { n: Infinity } })), /.*/);
});

test("ts must be ISO-8601; session must be non-empty", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ ts: "yesterday" })), /ts MUST be/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ session: "" })), /session MUST be/);
});

test("hashProvenanceEvent refuses to hash an invalid event", () => {
  assert.throws(() => hashProvenanceEvent({ kind: "nope" }), /refusing to hash an invalid event/);
});

// ---- R1 redteam regression coverage ----------------------------------------

test("CRIT — prev_link single-element array is rejected (no String() coercion)", () => {
  // String(["aaa…64"]) === "aaa…64" would have passed the regex and stored an ARRAY,
  // breaking byte-exactness at the seam. Type-guard MUST reject it.
  assert.throws(() => buildProvenanceEvent(baseArgs({ prevLink: ["a".repeat(64)] })), /prev_link MUST be/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ prevLink: 123 })), /prev_link MUST be/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ prevLink: { hex: "a".repeat(64) } })), /prev_link MUST be/);
});

test("HIGH — ISO-8601 acceptance: offset + fractional forms are valid", () => {
  for (const ts of ["2026-06-01T00:00:00+09:00", "2026-06-01T00:00:00.123Z", "2026-06-01T00:00:00-05:00"]) {
    const evt = buildProvenanceEvent(baseArgs({ ts }));
    assert.equal(evt.ts, ts);
  }
});

test("HIGH — impossible calendar/clock fields are rejected (month 13, hour 25, Feb 30)", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ ts: "2026-13-01T00:00:00Z" })), /out-of-range|not a valid/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ ts: "2026-06-01T25:00:00Z" })), /out-of-range|not a valid/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ ts: "2026-02-30T00:00:00Z" })), /out-of-range|not a valid/);
});

test("HIGH — payload credential-shaped key is rejected (model_key in payload)", () => {
  // the side-door the operator_ref allowlist doesn't cover
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { model_key: "sk-shared-gcp" } })), /credential-shaped key forbidden/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { api_key: "x" } })), /credential-shaped/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { db_password: "x" } })), /credential-shaped/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: { nested: { auth_token: "x" } } })), /credential-shaped/);
  // a legitimate non-credential key with similar shape still passes
  const ok = buildProvenanceEvent(baseArgs({ payload: { keyboard: "qwerty", monkey: 1 } }));
  assert.ok(ok);
});

test("HIGH — prototype-pollution key in payload is rejected (JSON.parse own-enumerable __proto__)", () => {
  // own-enumerable __proto__ that would hit the coc-sign __proto__ setter footgun
  const polluted = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: polluted })), /prototype-pollution key forbidden/);
  const ctorKey = JSON.parse('{"constructor": {"y": 2}}');
  assert.throws(() => buildProvenanceEvent(baseArgs({ payload: ctorKey })), /prototype-pollution/);
});

test("MED — operator_ref.display_id wrong type is rejected", () => {
  assert.throws(() => buildProvenanceEvent(baseArgs({ operatorRef: { ...OP, display_id: 123 } })), /display_id, when present/);
  assert.throws(() => buildProvenanceEvent(baseArgs({ operatorRef: { ...OP, display_id: null } })), /display_id, when present/);
});

test("determinism — nested-payload key reorder does not change the hash", () => {
  const a = buildProvenanceEvent(baseArgs({ payload: { outer: { x: 1, y: 2 }, list: [1, 2] } }));
  const b = buildProvenanceEvent(baseArgs({ payload: { list: [1, 2], outer: { y: 2, x: 1 } } }));
  assert.equal(hashProvenanceEvent(a), hashProvenanceEvent(b), "nested key order is canonicalized");
});

test("chain-of-3 cascade — tampering an ancestor breaks every downstream prev_link", () => {
  const g = chainProvenanceEvent(null, baseArgs({ kind: "HumanInput" }));
  const s = chainProvenanceEvent(g, baseArgs({ kind: "Decision", payload: { d: "15m" } }));
  const t = chainProvenanceEvent(s, baseArgs({ kind: "Action", payload: { tool: "Edit" } }));
  // rebuild the chain from a tampered genesis; every downstream hash diverges
  const gT = buildProvenanceEvent(baseArgs({ kind: "HumanInput", payload: { text: "TAMPERED" } }));
  const sT = chainProvenanceEvent(gT, baseArgs({ kind: "Decision", payload: { d: "15m" } }));
  assert.notEqual(s.prev_link, sT.prev_link, "second link diverges under genesis tamper");
  assert.notEqual(hashProvenanceEvent(s), hashProvenanceEvent(sT));
  // original tip's stored prev_link still matches its true (untampered) parent
  assert.equal(t.prev_link, hashProvenanceEvent(s));
});
