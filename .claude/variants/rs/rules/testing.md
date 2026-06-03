<!-- slot:lang-testing-extensions -->

## rs USE-template testing — binding-consumer context

This variant serves the rs USE templates — **Python and Ruby developers writing applications that consume kailash-rs through bindings**. You write Python (or Ruby), not Rust. The bindings give you a Pythonic API that maps to the Rust runtime under the hood, but your code, tests, and tools are all Python (or Ruby).

Everything in the universal testing rules above (Probe-Driven Verification, Audit Mode, Regression Testing, Test Resource Cleanup, 3-Tier, Coverage, env-var serialization, plugin/marker pairing, E2E pipeline regression, state-persistence read-back) applies unchanged. The sections below ADD the binding-consumer specializations — they do not replace the universal rules.

## Kailash Binding Patterns

```python
# Use the Python binding API — never reach into the Rust crate directly
import kailash

def test_workflow_execution():
    reg = kailash.NodeRegistry()
    builder = kailash.WorkflowBuilder()
    builder.add_node("NoOpNode", "n1", {})
    wf = builder.build(reg)
    rt = kailash.Runtime(reg)
    result = rt.execute(wf)
    assert result["results"] is not None
```

## MUST: One Direct Test Per Variant Through The Binding

The universal "One Direct Test Per Variant In Every Delegating Pair" rule above applies at the binding boundary specifically. When a binding-layer class exposes paired variants delegating to a shared Rust core (`get`/`get_raw`, `post`/`post_raw`, `put`/`put_raw`, `delete`/`delete_raw`), each variant MUST have at least one test that calls it directly **through the Python or Ruby binding** — not a test that calls one variant and reaches the other by delegation.

```python
# DO — one test per variant, called through the binding
def test_service_client_get_typed_returns_dict(client):
    user = client.get("/users/42"); assert user["name"] == "Alice"
def test_service_client_get_raw_returns_response_dict(client):
    resp = client.get_raw("/users/42"); assert resp["status"] == 200

# DO NOT — exercise only the typed variant and trust delegation
def test_service_client_get_works(client):
    user = client.get("/users/42"); assert user["name"] == "Alice"
# refactor of get_raw's PyO3/Magnus error mapping ships a silent FFI regression
```

**Why:** Binding-layer paired variants cross the FFI boundary independently — a refactor that changes the typed variant's PyO3 conversion while leaving the raw variant alone ships a silent FFI regression. Tests that only exercise one variant cannot catch this because the failure mode is _across_ the binding boundary, not in the shared Rust core.

**BLOCKED rationalizations:** "The typed variant calls the raw variant internally" / "Both variants share the same Rust execute() core" / "Integration tests at the Rust layer catch this" / "PyO3 wrapping is mechanical, it can't drift".

### MUST: Mechanical Enforcement Via Grep

`/redteam` MUST grep the binding test directory for direct call sites of each known raw variant and report any pair where one side has zero matches.

```bash
TEST_DIR="${TEST_DIR:-tests}"
for variant in get_raw post_raw put_raw delete_raw; do
  count=$(grep -rln "client\.$variant(" "$TEST_DIR" | wc -l)
  [ "$count" -eq 0 ] && echo "MISSING: no test calls client.$variant() through the binding"
done
```

**Why:** Mechanical grep at audit time catches the regression before it reaches a downstream consumer. Manual "I think I tested both" is not auditable across PyO3/Magnus binding refactors.

Origin: BP-046 (kailash-rs ServiceClient binding test coverage, 2026-04-14, commit `d3a14a73`) — Rust `put_raw`/`delete_raw` had wiremock coverage; the Python binding equivalents had none.

## MUST: Rust `pub use` Result-Type Coverage Pinned By Literal-Identifier Wiring Tests

When the underlying Rust crate `pub use`-exports a result type (struct / enum / trait), the per-symbol coverage sweep (`tools/sweep-redteam.py --json`) reports a HIGH gap unless at least one test file binds the type to a `let var: <Type> = ...` declaration. Inline `#[cfg(test)]` tests that exercise the API but never name the type literally are NOT sufficient — the sweep greps for `<Type>` as an identifier; `let result = build()` binds nothing the tool can see.

Pin coverage in a dedicated `tests/test_<module>_wiring.rs` that: (1) imports the type by name from the crate's public surface; (2) constructs a value via the canonical public-API entry; (3) binds it to `let var: <Type> = ...`; (4) asserts every public field individually; (5) for trait wiring, casts a concrete impl to `&dyn TraitName`.

```rust
// DO — wiring test binds the type literally; sweep tool sees it
use kailash_ml::engine::{DriftMonitor, DriftConfig, DriftReport, FeatureDriftResult};

#[test]
fn drift_report_full_field_assertions() {
    let mut monitor = DriftMonitor::from_reference(&data, &names, DriftConfig::default()).unwrap();
    let report: DriftReport = monitor.check(&current).unwrap();   // ← literal type binding
    assert!(!report.features.is_empty());
    let f0: &FeatureDriftResult = &report.features["f0"];          // ← literal type binding
    assert_eq!(f0.feature_name, "f0");
}

// DO NOT — inline test exercises the API but never names the type literally
let result = DriftMonitor::from_reference(&d,&n,DriftConfig::default()).unwrap().check(&c).unwrap();
// `result` shadows the type; sweep tool sees nothing
```

**BLOCKED rationalizations:** "The inline `#[cfg(test)]` tests already exercise the API; a wiring test is duplication" / "Field-by-field assertions are brittle" / "The type is `pub use`-exported, that proves it's reachable" / "Integration tests will catch a refactor" / "We shouldn't author tests for the sweep tool's quirks" / "I'll add a wiring test when the sweep flags it".

**Why:** A `pub use`-exported type with no literal-identifier binding in any test corpus is structurally indistinguishable from a removed type — the sweep reports a HIGH gap because there's no syntactic anchor. Wiring tests make the type discoverable to the per-symbol scan AND pin every public field's shape so a downstream refactor that drops a field fails one specific assertion. The trait-cast pattern (`&dyn TraitName`) extends the same defense to trait surfaces.

### Same-Shard Accessor For Orphaned `pub use` Types

When a wiring test cannot construct or observe a `pub use`-exported type because it has NO public constructor AND NO public accessor on any owning facade, the disposition per `rules/autonomous-execution.md` Rule 4 is to add the missing accessor IN THE SAME SHARD — typically a one-line `pub fn <field>(&self) -> &<Type> { &self.<field> }` mirroring the existing accessor pattern. Removing the type from `pub use` is also acceptable; leaving it `pub use`-exported but unreachable is BLOCKED.

**Why:** A `pub use`-exported type with no public construction/observation path is the orphan failure mode at the type-export level. Origin: 2026-05-06 RT-1/2/3 (PRs #816/#817/#818) — `tools/sweep-redteam.py` flagged 22 HIGH gaps whose types had inline-test exercise but no literal-identifier binding; RT-2 surfaced the orphan-accessor variant (`DriftSnapshot` `pub use`-exported, no accessor; same-shard `reference_snapshot()` added).

**Trust Posture Wiring (this section):** `halt-and-report` (lexical regex against `let result = ` with no typed binding cannot ship `block` per `hook-output-discipline.md` MUST-2; structural AST walk required to upgrade). Grace 7d. Cumulative 3×/30d → posture drop per `trust-posture.md` §4. Detection: `tools/sweep-redteam.py --json` HIGH gap on `pub use`-exported type with zero literal-identifier hits, OR `find crates/*/tests/ -name 'test_*_wiring.rs' | xargs grep -L "let .*: <Type>"`.

## Shared-Resource Test Isolation (Rust SDK)

The universal "Serialize Env-Var-Mutating Tests Via Module Lock" rule generalizes to any shared external state Rust integration tests touch — a Docker Postgres container, Redis, a shared cache, a file-system lockfile.

### MUST: Use `tokio::sync::Mutex` For Async Guards That Cross `.await`

Any two integration tests that mutate the SAME shared external resource MUST serialize through a `tokio::sync::Mutex` at test-module scope. The `std::sync::Mutex` form is BLOCKED when the guard crosses an `.await` — it trips `clippy::await_holding_lock` AND risks deadlock if the tokio runtime moves the task to a different thread mid-await.

```rust
// DO — tokio::sync::Mutex, guard survives .await safely
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
static PG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[tokio::test]
async fn test_real_pg_round_trip() {
    let _g = PG_LOCK.lock().await;
    let pool = connect_real_pg().await;        // .await under tokio::sync guard — OK
    assert_eq!(pool.fetch_all("...").await.len(), 3);
}

// DO NOT — std::sync::Mutex across .await
static PG_LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));
#[tokio::test]
async fn test_real_pg_round_trip() {
    let _g = PG_LOCK.lock().unwrap();          // BLOCKED — held across .await
    let pool = connect_real_pg().await;        // clippy::await_holding_lock + deadlock risk
}
```

**BLOCKED rationalizations:** "Tests pass in isolation, CI scheduling is the bug" / "Docker is slow enough that tests don't overlap" / "`cargo nextest` already isolates per-test processes" (only with `test-threads = 1`) / "std::sync::Mutex is faster and the guard is brief" / "`#[serial]` from serial_test is simpler" / "We'll migrate later".

**Why:** `cargo nextest`/`cargo test` default to thread-level parallelism. Two `#[tokio::test]` functions that both `connect_real_pg().await` against the SAME container race on startup; `tokio::sync::Mutex` is the only async-safe primitive; `std::sync::Mutex` deadlocks when the runtime re-schedules the task mid-await; `#[serial]` has worse poisoning errors and doesn't compose with nested serialization domains. Origin: kailash-rs commit `b4ed4cb5` (2026-04-22) — fixed a 75% Mac-runner flake from a Docker Postgres startup race (`specs/ci-infrastructure.md §5.4`).

## Test-Skip Triage Decision Tree (binding-consumer)

Every skipped / xfailed / deleted test MUST be classified into exactly one tier. Silent skips, unbounded `@pytest.mark.skip`, or empty bodies pretending to be tests are BLOCKED.

| Tier           | When                                                           | Action                                                                                               |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **ACCEPTABLE** | Missing dep / infra unavailable / platform constraint          | Keep skip; reason names the constraint (`@pytest.mark.skipif(not REDIS, reason="redis required")`)   |
| **BORDERLINE** | Real library limitation; documenting a known-failing edge      | Convert to `@pytest.mark.xfail(strict=False, reason="...")` — preserves body, flips green when fixed |
| **BLOCKED**    | "TODO" / "needs refactor" / "flaky" / "times out" / empty body | DELETE the test (and abandoned fixtures); if the bug matters, file an issue                          |

```python
# DO — ACCEPTABLE: infra-conditional skip
@pytest.mark.skipif(os.environ.get("POSTGRES_TEST_URL") is None, reason="requires POSTGRES_TEST_URL")
def test_real_postgres_round_trip(): ...
# DO — BORDERLINE: xfail with full reason
@pytest.mark.xfail(strict=False, reason="kailash-rs bindings do not yet surface this edge via PyO3")
def test_binding_edge_case(): ...
# DO NOT — BLOCKED: TODO-style silent skip / empty body
@pytest.mark.skip(reason="TODO")
def test_something(): ...
```

**BLOCKED rationalizations:** "It's only one skipped test" / "I'll fix it when I have time" / "It flakes — skip it for now" / "TODO comments in the skip reason are documentation".

**Why:** Silent skips inflate the green count without exercising code; for binding consumers a skipped binding test hides a broken FFI path that only surfaces in production. Deletion is the only honest disposition for a test that does not run; xfail the only honest disposition for a documented real limitation. Origin: cross-SDK from kailash-py gh #512 / PR #518 (2026-04-19).

## Binding-boundary Tier rationale

The universal 3-Tier contract applies; the binding boundary sharpens the Tier 2/3 "why":

- **Tier 2 (Integration), NO mocking:** mocks at the binding boundary bypass the FFI path entirely (connection handling, value serialization, lifetime management) — a passing mock-based test gives zero confidence the binding actually works.
- **Tier 3 (E2E), read-back MANDATORY:** the binding write path crosses the Python/Ruby→Rust boundary, value serialization, and the DB driver. Any layer can silently succeed without persisting; only a read-back proves the data landed.

<!-- /slot:lang-testing-extensions -->
