# `.claude/operators.roster.json` — Multi-Operator Roster

The roster is the in-repo, committed, per-emitter hash-chained identity substrate for multi-operator COC. It maps `person_id` → role + GitHub binding + signing keys.

**Files in this directory:**

- `operators.roster.json` — the live roster (template values until enrollment runs).
- `operators.roster.schema.json` — JSON Schema (draft 2020-12) declaring the shape.
- `hooks/lib/roster-schema-validate.js` — vendored validator consuming the schema.

**Authority:** `workspaces/multi-operator-coc/02-plans/01-architecture.md` §2.1 + §2.3 (design v11, CONVERGED). Shipped by shard A0b-1.

## Why the live file ships with `PLACEHOLDER-…` values

This shard (A0b-1) ships the SHAPE — schema + validator + command body. The TRUST ROOT is populated by the next shard, A0b-2a (`/whoami --enroll-genesis`), which runs the network-permitted, blocking, fail-CLOSED enrollment ceremony:

1. `gh api repos/{owner}/{repo}` → captures the verified external GitHub repo-owner login.
2. `gh api .../commits/{root_commit} .commit.verification.verified == true` → captures the verified root-commit SHA.
3. Emits a signed `genesis-anchor` record in the coordination log, owner-bound by the key whose `github_login` matches the verified owner.

Until A0b-2a runs and populates this file with real values, every consumer (the genesis-anchor-guard hook, the operator-id resolver, the gate matrix) MUST treat any `persons[]` entry whose `person_id` starts with the literal `PLACEHOLDER-` as **unenrolled** and refuse to use it for authority decisions. The enrollment ceremony is what makes the substrate real.

## How operators add themselves after genesis

Once the genesis owner has run `/whoami --enroll-genesis`, every other operator runs:

```
/whoami --register
```

This subcommand (shipped by A0b-1) appends a `person_id` proposal to the roster on a new feature branch `codify/<display_id>-<date>`, pushes the branch, and opens a PR. The roster file is branch-protected on `main`; the PR + 2-of-N owner review (enforced by repo settings + `operator-gate.js` from shard C2) is what merges the edit.

**Operators NEVER edit `operators.roster.json` directly on `main`.** That is a branch-protection violation; the structural defense is the PR-only flow.

## Schema highlights

- `genesis.repo_owner_kind` is `user` or `org` (architecture §2.3 R5-S-02 — org-owned branches anchor via `gh api orgs/{org}/memberships/{login}`).
- `genesis.genesis_generation` is a monotonic integer; bumped on `genesis-migration` (fold rule 9c).
- `genesis.provider` selects the VCS provider for the whole repo: absent (or `github`) ⇒ GitHub (the byte-unchanged default); `azure-devops` ⇒ Azure DevOps. ADO rosters additionally carry `genesis.ado_project` (the ADO project ref the coordination repo lives under; `genesis.repo_owner` is then the ADO **org**). A roster has exactly ONE provider — every ceremony + fold dispatches on it.
- `persons[].principal` (Entra UPN, e.g. `alice@contoso.com`) is the ADO identity binding — the analogue of `github_login`. On the ADO provider, `principal` is required and `github_login` is not; on GitHub, the reverse. Distinctness, derived-N, and gate authority bind on whichever field the provider selects (case-insensitive via `normalizePrincipal` / `normalizeLogin`).
- `persons[].role` is one of `owner`, `senior`, `contributor`. Role lives ONLY here.
- `persons[].host_role` is `human` or `ci`. `host_role: ci` is a valid declared value, recorded in this file, but **NEVER advisory-eligible at any gate** — that ineligibility predicate is enforced in shard A0b-2c (R5-S-04), not in this schema.
- `persons[].keys[]` is append-only under a `person_id`; each key carries `type` (`ssh` or `gpg`), `fingerprint` (the `verified_id`), and `pubkey` (armored).
- Strict `additionalProperties: false` at every level — unknown keys are rejected.

## Validation

```
node -e 'const v = require("./.claude/hooks/lib/roster-schema-validate.js"); const fs = require("fs"); console.log(v.validate(JSON.parse(fs.readFileSync(".claude/operators.roster.json", "utf8"))));'
```

(Node's `require` needs the explicit `./` prefix for relative paths; bare `.claude/...` is interpreted as a node_modules lookup.)

Expected output for a valid roster: `{ valid: true, errors: [] }`.

The tests at `tests/integration/operators-roster.test.js` exercise the schema across 18 Tier-1 cases (minimal valid roster, missing-required-property, enum violations, unknown-key rejection, empty-keys, missing-pubkey, missing-key-type) plus 2 Tier-2 cases (the `/whoami --register` PR-flow contract structure).
