# Zero-Tolerance Rules

## Scope

ALL sessions, ALL agents, ALL code, ALL phases. ABSOLUTE and NON-NEGOTIABLE.

## Rule 1: Pre-Existing Failures, Warnings, and Notices MUST Be Resolved Immediately

If you found it, you own it. Fix it in THIS run — do not report, log, or defer.

**Applies to** — "found it" includes, with equal weight:

- Test failures, build errors, type errors
- Compiler warnings, linter warnings, deprecation notices
- WARN/ERROR entries in the workspace's logs since the previous gate
- Runtime warnings emitted during the session (`DeprecationWarning`, browser console warnings, Dart analyzer notices)
- Peer-dependency warnings, missing-module warnings, version-resolution warnings

A warning is not "less broken" than an error. It is an error that the framework chose to keep running through. Both are owed.

**Process:**

1. Diagnose root cause
2. Implement the fix
3. Write a regression test
4. Verify with `npx vitest run` (web), `flutter test` (flutter), or `cargo test` (tauri-rs)
5. Include in current or dedicated commit

**BLOCKED responses:**

- "Pre-existing issue, not introduced in this session"
- "Outside the scope of this change"
- "Known issue for future resolution"
- "Reporting this for future attention"
- "Warning, non-fatal — proceeding"
- "Deprecation warning, will address later"
- "Notice only, not blocking"
- ANY acknowledgement, logging, or documentation without an actual fix

**Why:** Deferring broken code creates a ratchet where every session inherits more failures, and the codebase degrades faster than any single session can fix. Warnings are the leading indicator: today's `DeprecationWarning` is next quarter's "it stopped working when we upgraded".

**Mechanism:** The log-triage protocol in `rules/observability.md` MUST Rule 5 provides the concrete commands for scanning test runner output, build tool output, and `*.log` files. If `observability.md` is not loaded (e.g., editing a config file), the agent MUST still scan the most recent test runner and build tool output for WARN+ entries before reporting any gate as complete.

**Exceptions:**

- User explicitly says "skip this issue."
- Upstream third-party deprecation that cannot be resolved by updating or configuring the dependency in this session. Required disposition: pinned version with documented reason OR upstream issue link OR todo with explicit owner. Silent dismissal is still BLOCKED.

### Rule 1a: Scanner-Surface Symmetry

Findings reported by a security scanner on a PR scan MUST be treated identically to findings reported on a main scan. The argument "this also exists on main, therefore not introduced here" is BLOCKED.

```typescript
// DO — fix the finding in this PR regardless of main's state
// CodeQL alert js/clear-text-logging-sensitive-data on logRedisUrl() -> fix it here.
logger.info("redis.connect", { url: maskUrl(redisUrl) });

// DO NOT — rationalize based on main's scanner output
// "Same alert on main, out of scope for this PR"
logger.info("redis.connect", { url: redisUrl });  // still leaks, still my problem
```

**BLOCKED responses:**

- "Pre-existing on main, out of scope"
- "CodeQL only flags it on PR diffs"
- "Will be addressed when main re-scans"
- "Same alert ID exists upstream"
- "The main branch baseline suppresses it"

**Why:** "Same on main" is the institutional ratchet that defers fixes forever. Rule 1 already covers this in spirit; an explicit scanner-surface clause closes the rationalization gap.

## Rule 2: No Stubs, Placeholders, or Deferred Implementation

Production code MUST NOT contain:

- `TODO`, `FIXME`, `HACK`, `STUB`, `XXX` markers
- `throw new Error('Not implemented')` / `throw new Error('TODO')` (TypeScript)
- `throw UnimplementedError()` (Dart)
- `todo!()` / `unimplemented!()` (Rust, tauri-rs)
- Empty function bodies, `return undefined`, `return null // not implemented`
- `raise NotImplementedError` (any helper Python scripts)

**No simulated/fake data:**

- `simulated_data`, `fake_response`, `dummy_value`
- Hardcoded mock responses pretending to be real API calls
- `return { status: "ok" }` as a placeholder for real logic

**Frontend mock data is a stub:**

- `MOCK_*`, `FAKE_*`, `DUMMY_*`, `SAMPLE_*` constants
- `generate*()` / `mock*()` functions producing synthetic data
- `Math.random()` / `Random()` used for display data

**Why:** Frontend mock data is invisible to static detection but has the same effect — users see fake data presented as real.

**Extended examples (cross-framework wiring audit):** these patterns pass prior audits but fail wiring sweeps. They are equally BLOCKED.

- **Fake encryption** — a class that takes an `encryptionKey` parameter, stores it, and does nothing with it:

  ```typescript
  // BLOCKED — "encrypted" store that writes plaintext
  class EncryptedStore {
    constructor(private encryptionKey: string) {}
    set(k: string, v: string) {
      this.backend.set(k, v);  // no encryption applied
    }
  }
  ```

  **Why:** Operators pass a real key and assume data is encrypted at rest. The audit trail shows "encrypted store used"; the disk shows plaintext.

- **Fake transaction** — a wrapper that looks like a transaction but commits after every statement:

  ```typescript
  // BLOCKED — misnamed wrapper
  async function transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();  // no BEGIN, no COMMIT, no rollback on exception
  }
  ```

  **Why:** Callers write `await transaction(() => ...)` expecting atomicity; partial failure leaves half-committed state.

- **Fake health** — a health endpoint that returns 200 without checking anything:

  ```typescript
  // BLOCKED — always-green health endpoint
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'healthy' });  // no DB probe, no cache ping, no nothing
  });
  ```

  **Why:** Load balancers and orchestrators use the health endpoint to decide routing and restart decisions. A fake-healthy endpoint masks real outages.

- **Fake classification / redaction** — an `@classify("email", REDACT)` decorator that stores the classification but never enforces it on read.

  **Why:** Documented as a security control; ships as a no-op.

- **Fake tenant isolation** — a `multiTenant: true` flag that silently uses a shared cache key.

  **Why:** See `rules/tenant-isolation.md`. The orphan pattern surfaces at the cache key layer.

- **Fake metrics** — a metrics class where every counter is a no-op because `prom-client` isn't installed but there's no warning.

  **Why:** Operators rely on dashboards. A silent no-op metrics layer removes the observability contract without any signal. The fix emits a loud startup WARN AND an explanatory body from the `/metrics` endpoint.

## Rule 3: No Silent Fallbacks or Error Hiding

- `catch (e) {}` / `catch (_) {}` (empty catch in TypeScript) — BLOCKED
- `on Exception catch (_) {}` (empty catch in Dart) — BLOCKED
- `.catch(() => {})` (swallowed promise rejection) — BLOCKED
- `catch (e) { return null }` without logging — BLOCKED
- `Result::unwrap_or_default()` on error paths without logging (Rust, tauri-rs) — BLOCKED
- `except: pass` / `except Exception: return None` (any helper Python scripts) — BLOCKED

**Why:** Silent error swallowing hides bugs until they cascade into data corruption or production outages with no stack trace to diagnose.

**Acceptable:** Empty catch in cleanup/disposal where failure is expected AND documented with a comment.

### Rule 3a: Typed Delegate Guards For Null Backing Objects

Any delegate method that forwards to a lazily-assigned backing object MUST guard with a typed error before access. Allowing `TypeError: Cannot read property 'x' of null` to propagate from `null.method()` is BLOCKED.

```typescript
// DO — typed guard with actionable message
class JWTMiddleware {
  private validator: JWTValidator | null = null;

  private requireValidator(): JWTValidator {
    if (this.validator === null) {
      throw new Error(
        "JWTMiddleware.validator is null — construct via new JWTMiddleware(config) or " +
        "assign mw.validator = new JWTValidator(mw.config) in test setup"
      );
    }
    return this.validator;
  }

  createAccessToken(...args: unknown[]): string {
    return this.requireValidator().createAccessToken(...args);
  }
}

// DO NOT — raw delegation, opaque TypeError
class JWTMiddleware {
  validator: JWTValidator | null = null;
  createAccessToken(...args: unknown[]): string {
    return this.validator!.createAccessToken(...args);
    // TypeError: Cannot read properties of null (reading 'createAccessToken')
  }
}
```

**Why:** Opaque `TypeError` / null-pointer errors block N tests at once with no actionable message; a typed guard turns the failure into a one-line fix instruction.

## Rule 4: No Workarounds for Core SDK Issues

When you encounter a bug in Prism's compiler, stitch, or a sibling Kailash SDK, file a GitHub issue on the owning repository with a minimal reproduction. Use a supported alternative pattern if one exists. For issues inside this BUILD repo (web/flutter/tauri-rs/compiler/stitch), you have the source — fix it directly.

**Why:** Workarounds create a parallel implementation that diverges from upstream, doubling maintenance cost and masking the root bug from being fixed.

**BLOCKED:** Naive re-implementations, post-processing, downgrading.

## Rule 5: Version Consistency on Release

ALL version locations updated atomically across all prism surfaces:

1. `web/package.json` → `"version": "X.Y.Z"` (@kailash/prism-web)
2. `compiler/package.json` → `"version": "X.Y.Z"` (@kailash/prism-compiler)
3. `flutter/pubspec.yaml` → `version: X.Y.Z` (kailash_prism)
4. `tauri-rs/Cargo.toml` → `version = "X.Y.Z"` (kailash-prism-tauri)
5. `stitch/package.json` → `"version": "X.Y.Z"` (@kailash/prism-stitch, if present)

**Why:** Split version states cause `npm install @kailash/prism-web@X.Y.Z` to install a package whose internal version reports a different number, breaking version-gated logic across the web/flutter/tauri/compiler surfaces.

## Rule 6: Implement Fully

- ALL methods, not just the happy path
- If an endpoint exists, it returns real data
- If a service is referenced, it is functional
- Never leave "will implement later" comments
- If you cannot implement: ask the user what it should do, then do it. If user says "remove it," delete the function.

**Test files excluded:** `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*_test.dart`, `__tests__/`, `tests/`

**Why:** Half-implemented features present working UI with broken backend, causing users to trust outputs that are silently incomplete or wrong.

**Iterative TODOs:** Permitted when actively tracked.
