# Security Rules

ALL code changes in the repository.

## No Hardcoded Secrets

All sensitive data MUST use environment variables.

**Why:** Hardcoded secrets end up in git history, CI logs, and error traces, making them permanently extractable even after deletion.

```typescript
// TypeScript
❌ const apiKey = "sk-...";
❌ const password = "admin123";
❌ const databaseUrl = "postgres://user:pass@...";

✅ const apiKey = process.env.API_KEY;
✅ const password = process.env.DB_PASSWORD!;
✅ import 'dotenv/config';
```

```dart
// Dart
❌ final apiKey = 'sk-...';

✅ final apiKey = Platform.environment['API_KEY'];
✅ final apiKey = const String.fromEnvironment('API_KEY');
```

```rust
// Rust (tauri-rs)
❌ let api_key = "sk-...";

✅ let api_key = std::env::var("API_KEY")?;
```

## Parameterized Queries

All database queries MUST use parameterized queries or ORM.

**Why:** Without parameterized queries, user input becomes executable SQL, enabling data theft, deletion, or privilege escalation.

```typescript
// TypeScript (Prisma / Drizzle ORM)
❌ db.query(`SELECT * FROM users WHERE id = ${userId}`)
❌ `DELETE FROM users WHERE name = '${name}'`

✅ db.user.findUnique({ where: { id: userId } })  // Prisma
✅ db.select().from(users).where(eq(users.id, userId))  // Drizzle
✅ db.query("SELECT * FROM users WHERE id = $1", [userId])  // parameterized
```

## Credential Decode Helpers

Connection strings carry credentials in URL-encoded form. Decoding them at a call site with `decodeURIComponent(parsed.password)` is BLOCKED — every decode site MUST route through a shared helper module so the validation logic lives in exactly one place and drift between sites is impossible.

### 1. Null-Byte Rejection At Every Credential Decode Site (MUST)

Every URL parsing site that extracts `user`/`password` from a connection string MUST route through a single shared helper that rejects null bytes after percent-decoding. Hand-rolled `decodeURIComponent(parsed.password)` at a call site is BLOCKED.

```typescript
// DO — route through the shared helper
import { decodeUserinfoOrRaise } from '@kailash/prism-web/utils/url-credentials';

const url = new URL(connectionString);
const { user, password } = decodeUserinfoOrRaise(url);  // throws on \x00 after decode

// DO NOT — hand-rolled at the call site
const url = new URL(connectionString);
const user = decodeURIComponent(url.username ?? '');
const password = decodeURIComponent(url.password ?? '');  // no null-byte check
```

**BLOCKED rationalizations:**

- "The existing site already has the check"
- "This is a new dialect, the rule doesn't apply yet"
- "We'll consolidate later"
- "The URL comes from a trusted config file, null bytes can't happen"

**Why:** A crafted `mysql://user:%00bypass@host/db` decodes to `\x00bypass`; a MySQL client may truncate credentials at the first null byte and send an empty password, succeeding against any row with an empty `authentication_string`. Drift between sites with the check and sites without is unauditable without a single helper.

### 2. Pre-Encoder Consolidation (MUST)

Password pre-encoding helpers (encoding of `#$@?` etc.) MUST live in the same shared helper module as the decode path. Per-adapter copies are BLOCKED.

```typescript
// DO — single helper module owns both halves of the contract
import {
  preencodePasswordSpecialChars,
  decodeUserinfoOrRaise,
} from '@kailash/prism-web/utils/url-credentials';

const encoded = preencodePasswordSpecialChars(rawUrl);
const url = new URL(encoded);
const { user, password } = decodeUserinfoOrRaise(url);

// DO NOT — inline pre-encode in each adapter
const pwd = rawPwd.replaceAll('@', '%40').replaceAll(':', '%3A').replaceAll('#', '%23');
const url = `postgresql://${user}:${pwd}@${host}/${db}`;  // drifts from decode path silently
```

**Why:** Encode and decode are dual halves of one contract; splitting them across modules guarantees one half drifts. Round-trip tests are only meaningful when both ends share the helper.

## Input Validation

All user input MUST be validated before use: type checking, length limits, format validation, whitelist when possible. Applies to API endpoints, CLI inputs, file uploads, form submissions, Tauri IPC commands.

**Why:** Unvalidated input is the entry point for injection attacks, buffer overflows, and type confusion across every attack surface.

## Output Encoding

All user-generated content MUST be encoded before display in HTML templates, JSON responses, and log output.

**Why:** Unencoded user content enables cross-site scripting (XSS), allowing attackers to execute arbitrary JavaScript in other users' browsers.

```
❌ element.innerHTML = userContent
❌ dangerouslySetInnerHTML={{ __html: userContent }}

✅ element.textContent = userContent
✅ DOMPurify.sanitize(userContent)
```

## MUST NOT

- **No eval() on user input**: `eval()`, `new Function(userInput)`, `child_process.exec(userInput)` (TS) / `Process.run(userInput)` (Dart) / `Command::new(userInput)` (Rust) — BLOCKED

**Why:** `eval()` on user input is arbitrary code execution — the attacker runs whatever they want on the server/client.

- **No secrets in logs**: MUST NOT log passwords, tokens, or PII

**Why:** Log files are widely accessible (CI, monitoring, support staff) and rarely encrypted, turning every logged secret into a breach.

- **No .env in Git**: .env in .gitignore, use .env.example for templates

**Why:** Once committed, secrets persist in git history even after removal, and are exposed to anyone with repo access.

## Prism-Specific Security

- **Next.js**: Server Actions validate input with Zod, CSRF protection enabled, API routes authenticate
- **React**: No `dangerouslySetInnerHTML` with user content, sanitize all rendered data
- **Flutter**: Platform channel communication validated, no sensitive data in SharedPreferences without encryption
- **Tauri**: IPC commands validate all arguments, allowlist-only filesystem access, CSP headers configured

## Exceptions

Security exceptions require: written justification, security-reviewer approval, documentation, and time-limited remediation plan.
