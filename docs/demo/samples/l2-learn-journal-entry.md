---
type: DISCOVERY
date: 2026-06-14
author: co-authored
project: iw-legacy-permits
topic: clerk-role must not receive Restricted fields in API responses
phase: codify
verified_id: demo-verified-iw-l2
person_id: demo-person-iw-l2
display_id: pc2
tags: [data-classification, learn-loop, iw-demo]
relates_to: []
---

## What Was Discovered

During E3 rehearsal, the agent proposed a `GET /permits/debug` endpoint returning full applicant rows (name, address, phone) for clerk-role callers. The platform engineer redirected:

> "Clerks never get Restricted fields in API responses — only aggregates or redacted views. See data-classification policy."

The UserPromptSubmit hook captured this as a `user_correction` observation. `/learn` surfaced it in the digest; `/codify` on `iw-coc-template` strengthened `rules/iw-data-classification.md` with an explicit clerk-role MUST block and DO/DO NOT examples.

## Why It Matters

GRC policies in PDF form do not reach the coding agent. The **learn → codify** loop turns a one-time correction into a versioned rule that binds engineers, consultants, and runtime adapters on the next `/sync` cycle.

## Follow-Up

- [x] Rule update proposed in USE-template `.proposals/latest.yaml`
- [x] Gate-1 classify at loom (`coc` tier → `iw-coc-template` distribution)
- [ ] Downstream `/sync` in `iw-dept-consulting` (rehearsal — await operator approval)

## For Discussion

- What happens if the consultant never passed `/certify` but inherits the strengthened rule anyway?
- Would a SHADOW-mode copilot log a `would_deny` for the same Restricted dump pattern at runtime?
