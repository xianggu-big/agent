# QuestionForge — A Multi-Model Cross-Verification Agent Harness for Question Generation

> Turns a client's study material into a **multi-model cross-verified exam question bank** — with cost forecasting, a hard budget gate, human-in-the-loop review, and full audit trails.

This is not "a script that calls an LLM once." It is an **agent harness** built around a production concern: *how do you let an AI generate questions for paying customers, and still know where the money went, which errors got caught, and how to debug the one that didn't?*

---

## The Problem

Selling custom question banks for grad-school entrance exams has three real pain points:

1. **Opaque unit cost** — How many questions does a 200-page PDF yield? How many tokens? What should you quote? Guessing means either losing money or scaring clients away.
2. **Unusable raw output** — LLMs confidently produce wrong answers. Shipping those to a paying customer is a reputation incident.
3. **Undebuggable failures** — Which step, which model, how much spent, what went wrong? Without logs, you can never improve.

QuestionForge answers with three mechanisms: **quote before you commit, force cross-verification after generation, escalate every disagreement to a human.**

---

## Pipeline

```
Client material (PDF/Word/paste)
      │
      ▼
[0] Ingest ────── automatic page classification:
      │            · native text pages  → direct extraction
      │            · scanned text pages → local OCR fallback (free, offline)
      │            · figure pages       → raster extraction (47 images from one real exam PDF)
      │          Injection sanitizing: material is DATA, never instructions
      ▼
[0.5] Figure understanding ── a vision model (GLM-4V) "reads" diagrams into solvable text:
      │            · transcription (more accurate than OCR: handles sub/superscripts)
      │            · structural description (who is whose child / how vertices connect)
      │            → diagram questions become solvable as pure text
      ▼
[1] Cost estimate ── tokens & cost from (material size × question count × verifier count × figure count)
      │                → generates a client-ready quote
      ▼
   ★ HUMAN GATE: you approve the quote (and the budget) — only then does the agent run
      │
      ▼
[2] Generate ──── one designated model, batched (memory injected; figures auto-linked to questions)
      │
      ▼
[3] Difficulty tag ── LLM analyzes complexity → easy / medium / hard
      │
      ▼
[4] Cross-verify ── ≥2 models from DIFFERENT vendors solve every question
      │               independently — explicitly forbidden from seeing the proposed answer
      ▼
[5] Adjudicate ── unanimous → auto-accepted
                   any disagreement → human review queue
      │
      ▼
[6] Human review ── accept / edit-and-accept / regenerate / reject
                    (edits feed back into long-term memory)
      │
      ▼
[7] Export ────── subject pack (.js); figure-bearing questions get the original
                  image embedded as a base64 data URL
```

A **hard budget gate** runs across every step.

## Why a Vision Model, Not OCR

This is the project's key technical judgment, backed by measurements:

| Content type | OCR result | Verdict |
|---|---|---|
| Scanned text paragraphs | Good Chinese readability (1,320 chars measured) | ✅ OCR suffices (free, offline) |
| Math notation | `O(log₃n)` → `O(log,n)`, `n³` → `n'` | ⚠️ Sub/superscripts corrupted |
| **Tree/graph/matrix/sort-trace diagrams** | Measured output for a tree diagram: `oe`, `i` | ❌ **Useless** |

**Root cause**: a tree diagram's information is the *structural relation* — "who is whose child" lives in the edges, not in any pixel of text. No OCR plugin can recover it.

So the design splits the two: **scanned text goes to local OCR (free fallback), diagrams go to a vision model for semantic description.** The vision model emits solvable prose:

> 【Structure】Binary tree: root A; left subtree root B (left child D, right child F); right subtree root C (C's left child E, E's right child G)

Questions built from this are **solvable as pure text**, while the original image is also embedded in the pack so students see both.

---

## Engineering Highlights

| Capability | Implementation | Why it matters |
|---|---|---|
| **Multi-model cross-verification** | Every question solved independently by 2+ models from different vendors; only unanimity auto-accepts | A single model cannot detect its own systematic errors. Heterogeneous disagreement is a high-quality error detector. |
| **Two-channel ingestion** | Pages auto-classified: native text / scanned (local OCR) / figures (vision model) | One real exam PDF yielded 47 images across 12 all-image pages — text-only extraction silently loses a third of the content |
| **Diagram semanticization** | Vision model emits a *structural description* rather than OCR text | A tree diagram's OCR output is garbage; structure must be understood, not transcribed |
| **Inline figure embedding** | Questions link to source figures; export converts them to base64 data URLs | Zero-config rendering in the study client, no external file dependencies |
| **Predictable cost** | `lib/cost.js` estimates from material size × count × verifier count × figure count, then renders a quote | Turns "gut-feel pricing" into cost-plus pricing |
| **Hard budget gate** | Per-call metering; `BudgetExceeded` pauses the task, resumable after a top-up; vision phase has its own budget | Prevents runaway API spend |
| **Idempotent resumable pipeline** | Progress tracked along three axes (requirement / question / verifier) | Crash or reboot mid-run and resume without duplicates |
| **Prompt-injection defense** | Client material treated as untrusted: pattern matching, quarantine markers, explicit data-vs-instruction framing | A malicious line inside a client PDF cannot hijack the agent |
| **Human-in-the-loop** | Disagreements queue for review; edit-and-accept writes corrections into long-term memory | Human judgment becomes the agent's memory |
| **Full observability** | Every LLM call, token count, cost, and verdict appended to `events.jsonl` | Debug down to the exact step and model |
| **Quantified quality** | Golden-set evaluation against verified past-exam questions | Makes "can we auto-accept?" a data decision with an 85% threshold |
| **Zero dependencies** | Backend uses only Node built-ins; file-based storage | No DB, no `npm install`, double-click to run |

---

## Quick Start

```bash
node server.js          # no npm install required
# → http://localhost:8540
```

Demo mode is on by default: **no API keys needed.** It uses reproducible mock responses to exercise the entire pipeline (generate → verify → disagree → human → export).

For real use: open **Models & Budget**, enter your API keys, and turn off demo mode.

---

## Role Configuration

| Role | Purpose | Suggestion |
|---|---|---|
| `generator` | Produces questions | Use your strongest model |
| `classifier` | Rates difficulty | A cheap model is fine |
| `verifier1/2/…` | Independently re-solves every question | **At least 2, preferably from different vendors** |
| `vision` | Turns diagrams into text | **Must be a vision-capable model** (GLM-4V / Qwen-VL); DeepSeek's main API cannot see images |

Cross-verification only pays off when the verifiers are *heterogeneous* — two instances of the same model tend to share the same blind spots.

Vision pricing is per image, so figure-dense material costs more; the quote lists this as a separate line item. The vision phase also carries its own budget cap (`visionBudgetYuan`, default ¥2).

## Prerequisites

- **Node.js** (backend, no npm dependencies)
- **Python + pymupdf + pytesseract** (material parsing; tesseract needs the `chi_sim` language pack for Chinese) — not required if you only paste text
- **A vision-capable model API key** — only needed when material contains diagrams

---

## Handoff to the Study Client

Exported subject packs are plain `.js` files that drop into the study client's `data/subjects/` directory — instantly becoming a new practice subject with syllabus chapters, difficulty tags, and explanations.

```
QuestionForge (production side)  →  subject-xxx.js  →  Study client (learner side)
```

---

## Layout

```
server.js             HTTP server + REST API (zero deps)
lib/
  agent.js            Pipeline state machine (generate→tag→verify→adjudicate), idempotent
  llm.js              LLM client: multi-role config, metering, budget gate, retry backoff
  cost.js             Cost estimation & quote rendering
  guard.js            Prompt-injection defense
  evals.js            Golden-set evaluation
  store.js            File-based storage
  mock.js             Deterministic demo mode
  parse.py            PDF/Word/txt extraction
web/                  Console frontend (vanilla JS, no framework)
data/                 Runtime data (tasks, logs, memory, exports)
```

---

## Acceptance Metric

Against 47 **manually verified** past-exam questions as the golden set:

- **Per-verifier accuracy** — each model's independent solve rate
- **Consensus accuracy** — correctness when all verifiers agree (the safety boundary for auto-accept)
- **Threshold** — consensus ≥ 85% → PASS. Below that, swap or add verifier models.

---

## Known Boundaries

- **Human review is not optional.** Disagreements require a human decision — by design. The AI completes the deterministic 90%; the human owns the final 10%.
- **Vision model required for diagrams.** DeepSeek's main API cannot see images; pair it with GLM-4V / Qwen-VL. Billed per image, so figure-dense material costs noticeably more (itemized in the quote).
- **OCR distorts formulas.** Local OCR reads `O(log₃n)` as `O(log,n)`; formula-heavy scans should go through the vision channel.
- **Difficulty tags are model judgments**, suitable for practice weighting, not precise grading.
- **Copy protection**: static packs cannot be technically protected; client codes are embedded in pack names for traceability.
- **Demo-mode numbers are simulated** and labeled as such.
