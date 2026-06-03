---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
  - "**/*_test.dart"
  - "**/test/**"
  - "**/tests/**"
  - "**/__tests__/**"
  - "**/vitest.config.*"
  - "**/playwright.config.*"
  - "**/.spec-coverage*"
  - "**/.test-results*"
  - "**/02-plans/**"
  - "**/04-validate/**"
---

# Testing Rules

## Test-Once Protocol (Implementation Mode)

During `/implement`, tests run ONCE per code change, not once per phase.

**Why:** Running the full test suite in every implementation phase wastes 2-5 minutes per cycle, compounding to significant delays across a multi-phase session.

1. `/implement` runs full suite ONCE per todo, writes `.test-results` to workspace
2. Pre-commit runs Tier 1 unit tests as fast safety net
3. CI runs the full matrix as final gate

**Re-run during /implement only when:** commit hash mismatch, infrastructure change, or specific test suspected wrong.

## Audit Mode Rules (Red Team / /redteam)

When auditing test coverage, the rules invert: do NOT trust prior round outputs. Re-derive everything.

### MUST: Re-derive coverage from scratch each audit round

```bash
# DO: re-derive (web)
npx vitest --list

# DO: re-derive (flutter)
flutter test --reporter json

# DO NOT: trust the file
cat .test-results  # BLOCKED in audit mode
```

**Why:** A previous round may have written `.test-results` claiming "5950 tests pass" — true, but those tests covered the OLD code, while new spec modules have zero tests. Without re-derivation, the audit certifies test counts that don't correspond to the new functionality.

### MUST: Verify NEW modules have NEW tests

For every new module a spec creates, grep the test directory for an import of that module. Zero importing tests = HIGH finding regardless of "tests pass".

```bash
# DO (web)
grep -rln "import.*ButtonAtom\|from.*@kailash/prism-web" web/src/**/*.test.ts web/src/**/*.test.tsx
# Empty → HIGH: new module has zero test coverage

# DO (flutter)
grep -rln "import.*package:kailash_prism/atoms/button" flutter/test/
# Empty → HIGH: new module has zero test coverage

# DO NOT
cat .test-results | grep -c PASSED  # Suite-level count tells you nothing about new modules
```

**Why:** Counting passing tests at the suite level lets new functionality ship with zero coverage as long as legacy tests still pass. Per-module test verification catches this.

### MUST: Verify security mitigations have tests

For every § Security Threats subsection in any spec, grep for a corresponding test name. Missing = HIGH.

```bash
# Spec § Threat: XSS via dangerouslySetInnerHTML
grep -rln "xss.*dangerouslySetInnerHTML\|test.*xss" web/src/ flutter/test/
# Empty → HIGH: documented threat has no test
```

**Why:** Documented threats with no test become "we said we'd handle it" claims that nothing actually verifies. Threats without tests are unmitigated.

See `skills/spec-compliance/SKILL.md` for the full spec compliance verification protocol.

## Regression Testing

Every bug fix MUST include a regression test BEFORE the fix is merged.

**Why:** Without a regression test, the same bug silently re-appears in a future refactor with no signal until a user reports it again.

1. Write test that REPRODUCES the bug (must fail before fix, pass after)
2. Web: place in `web/src/__tests__/regression/issue-*.test.ts`
3. Flutter: place in `flutter/test/regression/issue_*_test.dart`
4. Regression tests are NEVER deleted

```typescript
// Web (vitest)
describe('Regression: #42 — ButtonAtom drops explicit id', () => {
  it('preserves explicit id prop', () => {
    const { getByTestId } = render(<ButtonAtom id="custom-id" />);
    expect(getByTestId('custom-id')).toBeDefined();
  });
});
```

```dart
// Flutter
void main() {
  testWidgets('Regression: #42 — ButtonAtom drops explicit key', (tester) async {
    await tester.pumpWidget(ButtonAtom(key: ValueKey('custom-id')));
    expect(find.byKey(ValueKey('custom-id')), findsOneWidget);
  });
}
```

### MUST: Behavioral Regression Tests Over Source-Grep

Regression tests MUST exercise the actual code path (render the component, call the function, assert the raise/return). Grepping source files for literal substrings is BLOCKED as the sole assertion.

```typescript
// DO — behavioral: render, assert the contract
describe('Regression: sanitize user-rendered content', () => {
  it('rejects script tags in ButtonAtom children', () => {
    const { container } = render(<ButtonAtom>{'<script>alert(1)</script>'}</ButtonAtom>);
    expect(container.querySelector('script')).toBeNull();
  });
});

// DO NOT — source-grep: pins implementation, breaks on refactor
it('sanitization check exists', () => {
  const src = fs.readFileSync('web/src/atoms/button.tsx', 'utf8');
  expect(src).toMatch(/DOMPurify/);  // breaks when logic moves to a shared helper
});
```

**Why:** Source-grep tests pin the implementation, not the contract; refactoring to a shared helper (the right move) breaks them. Behavioral tests survive refactors and survive being moved between modules.

### MUST: Verified Numerical Claims In Session Notes

Any numerical claim about test counts, file counts, or coverage in session notes / wrapup MUST be produced by a verifying command (`npx vitest --list | wc -l`, `git diff --stat`) at the moment of writing. Hand-typed numbers are BLOCKED.

```bash
# DO — verified: run the command, paste the output
# "62 regression tests pass" — verified via:
npx vitest --list web/src/__tests__/regression/ 2>&1 | grep -c '✓\|PASS'
# Output: 62

# DO NOT — hand-recall: author guesses a round number
# "86 regression tests pass" — author's recall; actual was 46.
```

**Why:** The "claim a number, never verify" pattern bypasses audit-mode rules and produces discrepancies. A verifying command costs 2 seconds and converts a memory bug into a script.

## 3-Tier Testing

### Tier 1 (Unit): Mocking allowed, <1s per test

### Tier 2 (Integration): Real infrastructure recommended

- Real API calls (test server), real browser rendering, real IPC for Tauri
- NO mocking (`vi.mock()`, `jest.mock()` — BLOCKED in integration tests)
- Web: `npx vitest run --config vitest.integration.config.ts`
- Flutter: `flutter test integration_test/`

**Why:** Mocks in integration tests hide real failures (API contract mismatches, rendering regressions, state management issues) that only surface with real infrastructure.

### Tier 3 (E2E): Real everything

- Real browser (Playwright for web, Flutter integration test driver)
- State persistence verification — every write MUST be verified with a read-back
- Web: `npx playwright test`
- Flutter: `flutter test integration_test/ --dart-define=E2E=true`

**Why:** E2E tests are the last gate before users — any abstraction here means the test validates something other than what users actually experience.

```
web/src/
├── __tests__/
│   ├── regression/    # Permanent bug reproduction (*.test.ts)
│   └── unit/          # Tier 1: Mocking allowed (*.test.ts)
├── e2e/               # Tier 3: Playwright (*.spec.ts)
└── integration/       # Tier 2: Real infrastructure (*.test.ts)

flutter/
├── test/              # Tier 1: Unit + widget tests (*_test.dart)
│   └── regression/    # Permanent bug reproduction
└── integration_test/  # Tier 2-3: Integration + E2E (*_test.dart)
```

## Coverage Requirements

| Code Type                            | Minimum |
| ------------------------------------ | ------- |
| General                              | 80%     |
| Financial / Auth / Security-critical | 100%    |

## State Persistence Verification (Tiers 2-3)

Every write MUST be verified with a read-back:

```typescript
// ❌ Only checks API response
const result = await api.createTheme({ name: 'Acme' });
expect(result.status).toBe(200);  // API may silently ignore params!

// ✅ Verifies state persisted
const result = await api.createTheme({ name: 'Acme' });
const theme = await api.getTheme(result.id);
expect(theme.name).toBe('Acme');
```

**Why:** API endpoints may return success while silently dropping fields. Without read-back, tests certify broken writes as passing.

## Prism-Specific

```typescript
// Web: Component rendering with real theme tokens
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@kailash/prism-web';

describe('ButtonAtom', () => {
  it('renders with theme tokens', () => {
    render(
      <ThemeProvider theme={enterpriseTheme}>
        <ButtonAtom variant="primary">Click</ButtonAtom>
      </ThemeProvider>
    );
    expect(screen.getByRole('button')).toHaveTextContent('Click');
  });
});
```

```dart
// Flutter: Widget test with real theme
void main() {
  testWidgets('ButtonAtom renders with theme tokens', (tester) async {
    await tester.pumpWidget(
      PrismTheme(
        theme: enterpriseTheme,
        child: ButtonAtom(variant: ButtonVariant.primary, child: Text('Click')),
      ),
    );
    expect(find.text('Click'), findsOneWidget);
  });
}
```

## Rules

- Test-first development for new features
- Tests MUST be deterministic (no random data without seeds, no time-dependent assertions)
  **Why:** Non-deterministic tests produce intermittent failures that erode trust in the test suite, causing developers to ignore real failures.
- Tests MUST NOT affect other tests (clean setup/teardown, isolated DBs)
  **Why:** Shared state between tests creates order-dependent results — tests pass individually but fail in CI where execution order differs.
- Web naming: `[feature].[scenario].test.ts` or `[feature].test.ts`
- Flutter naming: `[feature]_[scenario]_test.dart`
