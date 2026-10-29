# Write-up: AI Proposal Triage

**The idea in one line:** AI reads each proposal and pulls out facts with exact quotes; plain code applies the admin's criteria to those facts; a person checks the result and decides. Flow: [diagram/process-flow.png](diagram/process-flow.png).

## Sample set result

| Proposal | Result | Score | Why |
|---|---|---|---|
| A | Rank 1 | 75.6 | Most experience (14 installs), complete team plan, 12 weeks |
| E | Rank 2 | 62.5 | Best warranty, complete team plan, fewer installs (8) |
| C | Flagged | 53.9 | Hidden note telling automated reviewers to rank it first: ignored for scoring, held for a person. "Since 2020" may also include installs older than 5 years |
| D | Flagged | – | No committed timeline. Could score 61.4–76.4 (beats A at about 8 weeks), so ask the bidder rather than guess |
| B | Ineligible | – | Cheapest, but the licence belongs to a subcontractor "to be confirmed", not the bidder |

Reasons: [ranking.json](ranking.json). Full breakdown: [prototype/output/run-report.json](prototype/output/run-report.json).

**Assumptions** (not confirmed with MATACS):
- Scoring formulas are admin settings the brief doesn't give, so I chose them: experience full at 12 installs; price 0 at the $260k ceiling, full at 20% below; timeline 0 at 16 weeks, full at 8; warranty half panel (/25 yrs), half workmanship (/15); team a 4-item checklist.
- Over budget or over 16 weeks is ineligible. The 5-year window counts from 2026. "Named project lead" means a lead committed now, not a role assigned later.
- Flagged proposals get no rank until a person clears them.

## 1. AI vs. rules

**AI does one thing:** it turns free-text proposals into typed facts, such as "price = 238000" or "licence held by bidder = false", and each fact must come with the exact sentence that supports it. Reading differently worded documents is where AI adds value; regular expressions would break on "$5M", "five million" or "subcontractor to be confirmed after award".

**Everything else is code:** PDF reading, the manipulation scan, quote checking, mandatory gates, scoring formulas, hard limits, ranking, tie-breaks and reasons.

Why there: these steps are policy, and the admin already wrote the policy as criteria. Code applies it identically every time, is testable, and is explainable line by line. An AI asked to "score this out of 100" would invent its own policy, differently on each run.

## 2. Consistency and explainability

- **Same inputs, same output.** Scoring is deterministic code. AI extractions are cached by a hash of document + prompt version + criteria version + model, so ranking the same proposals twice returns the identical result without calling the AI again. The prototype tests this.
- **Fresh extractions are checked.** New AI output can vary slightly, so every value needs a quote found word-for-word in the document, and numbers must appear in their quote. An optional second run must agree, or the proposal is flagged.
- **Explainable by construction.** Per criterion the reviewer sees the fact, its quote, the formula and the points ("Price 42/100: $238,000; 0 at $260k, full at $208k"). The reason line is built from those numbers, not written by AI, so it can't contradict the score.

## 3. Human in the loop

- **Admin** defines and versions criteria (step 0).
- **Reviewer checkpoint** (step 9): sees the ranking next to the PDF with quotes and flags. They can confirm, correct an extracted fact (re-scored by the same rules), or override a status or position with a required reason. Flagged and ineligible items each need an explicit decision, e.g. "B exclusion confirmed" or "D: clarification requested".
- **Award** is always a person's decision; the tool only recommends.

**Audit log** (append-only): file hashes, uploader and time; criteria version and hash; prompt version, model, raw AI output and token cost; verification and scan results; every score and reason; every reviewer action (who, when, before → after, why); the final decision. That is enough to reproduce or defend any result.

## 4. Changing criteria

Criteria versions are never edited in place; saving changes creates v2.
- Existing runs stay attached to v1 and are labelled "scored on v1", so the audit trail stays true.
- The reviewer is told v2 exists and can re-score. If only weights or formulas changed, re-scoring uses cached facts with no AI calls; a new criterion runs only the new extraction.
- One ranking never mixes v1 and v2 scores.
- Changing criteria after bids are seen is a fairness risk, so changes during an open evaluation are logged with who and why.

## 5. Risks and safeguards

| Risk | Safeguard |
|---|---|
| **Wrong extraction** | Quotes checked against the source, numbers against their quote; optional double run; reviewer sees evidence and can correct. |
| **Made-up facts** | A value without a quote found in the document is discarded and flagged. The prompt says null beats a guess. |
| **Vague commitments** | "To be confirmed/determined" counts as not committed: B's licence fails, D's timeline is missing. |
| **Manipulation (prompt injection)** | Proposal fenced and marked untrusted; code scan before the AI; the AI only extracts facts, so even a fooled AI can't award points; one proposal per call. C is flagged, not rewarded. |
| **Bias** | Only criteria facts are scored; names, writing style and company size are never inputs. Absolute formulas, so one outlier (B's price) can't shift others' scores. Periodic human spot checks of extractions. |
| **Silent failures** | Unreadable PDFs, refusals and cut-off answers go to manual review; nothing is dropped quietly. |
| **Cost** | One cached AI call per proposal; re-scoring is free; token cost logged per run. |
| **Over-trust** | Labelled "recommendation"; unresolved flags block a final view; award needs a person. |
