# pi-code-quiz

A scope-first pi extension package for **active code-reading / code-understanding in quiz form**.

The goal is not to generate polished summaries. The goal is to force **active engagement**:

- look at real code
- answer a probing question
- commit to an interpretation
- then compare with an ideal answer

## Current MVP shape

This package currently focuses on a small, low-overhead workflow:

- one main command: `/quiz`
- `/quiz` opens a native **Glimpse** window
- scope is central: `workset`, `session`, `repo`, `file <path>`
- supports lightweight audience profiles via `--audience` or `--mode`
- uses the **active model** and **active thinking level** for quiz generation
- stores generated quiz packets as **hidden session entries**
- starts the Glimpse window immediately, then fills in the quiz once generation completes
- aims for plain-language, direct questions rather than clever/formal wording
- lets you discuss a question further after feedback, in a thread anchored to that card
- shows real snippets as evidence, but only in service of a question

It is **not** trying to be an Anki clone or a full spaced-repetition framework yet.

## Commands

```text
/quiz                             # default: current workset, opens native Glimpse UI
/quiz workset
/quiz session
/quiz repo
/quiz file src/foo.ts
/quiz src/foo.ts                  # shorthand for file scope when path exists
/quiz repo --thinking off         # faster / less reasoning
/quiz file src/foo.ts --thinking low
/quiz repo --audience scientist   # audience profiles: general, scientist, developer
/quiz repo --mode sci             # --mode is an alias for --audience
/quiz file src/foo.ts --audience developer --thinking low
/quiz-close                       # close the active quiz window
```

## Audience profiles

The quiz can lightly shift what it optimizes for:

- `general` / `gen` — accessible, mixed conceptual + code-mechanics questions; this is the default
- `scientist` / `sci` — emphasizes meaning of quantities, state representations, transformations, assumptions, and perturbations
- `developer` / `dev` — emphasizes interfaces, control flow, contracts, extension points, debugging, and refactoring consequences

This is meant to be a small prompt-level bias, not a giant separate feature branch.

## Follow-up discussion

After you answer a question and see the tutor feedback, you can open a **Discuss further** thread for that card.

This is intended for:
- asking for a more intuitive explanation
- asking what a quantity or state really means
- probing what would change under a perturbation
- clarifying something you half-understood from the feedback

The thread stays anchored to the current question, snippet, and ideal answer.

## Question style

The generator is explicitly biased toward:

- core abstractions
- usage / interface contracts
- mechanism / flow
- subtle assumptions / invariants
- change impact / failure modes
- plain-language, operational questions rather than clever or formal ones

But the **default ramp is intentionally gentle**:

- start with basic orientation / usage questions
- then move toward mechanism / flow
- only later include a subtle or change-impact question when warranted

It explicitly avoids generic dev-process trivia such as tests, CI, file layout, naming conventions, or tooling unless they are central to the abstraction being learned.

The scientist-oriented profile especially aims for questions like:

- what is this thing really representing?
- how do I use it correctly?
- what assumption matters?
- what changes if I perturb X?
- where is the real conceptual seam?

## Scope semantics

### `workset`
Current best-effort “what I’m actively touching” scope.

Currently this means a weighted mix of:
- recent conversation context
- files recently read / modified in the session
- files explicitly mentioned in recent conversation, when they resolve to real paths
- current working-tree changes as a fallback
- representative repo files when the session is sparse

### `session`
Quiz the current session’s recent ideas and touched code.

This is narrower than `workset`: it prefers files with strong session evidence rather than falling back to broader repo context.

### `repo`
Best-effort architecture / codebase orientation.

Currently uses:
- recent conversation context
- README if present
- a root manifest/config file if present (e.g. `package.json`, `pyproject.toml`, `Project.toml`)
- repo tree summary
- activity-weighted code files from the current session
- representative central code files as fallback

### `file <path>`
Quiz a specific file directly.

## Persistence

For now the extension stores hidden session entries like:

- generated quiz packets
- quiz runs / answers

This keeps the workflow lightweight and avoids adding an external database too early.

A later phase can add a small reusable question bank keyed by scope + source fingerprints.

## Roadmap

### Phase 0
- [x] scope-first command surface
- [x] separate quiz-generation call using active model
- [x] code-anchored question cards
- [x] hidden session persistence

### Phase 1
- [x] better workset resolution from session history
- [x] better repo file selection
- [x] stronger snippet extraction for large files
- [ ] reuse latest generated packet

### Phase 2
- [ ] small persistent question bank keyed by source fingerprints
- [ ] stale detection / lazy regeneration
- [ ] optional review / revisit flows

### Phase 3
- [ ] deliberate-practice / drill mode
- [ ] improve question quality on familiar repos and AI-generated code
- [ ] optional packet reuse / regeneration avoidance

## Install locally

```bash
pi install /absolute/path/to/pi-code-quiz
/reload
```

Or for one-off testing:

```bash
pi -e /absolute/path/to/pi-code-quiz
```
