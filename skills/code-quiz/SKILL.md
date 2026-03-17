---
name: code-quiz
description: Scope-first active code-reading and code-understanding in quiz form. Use when the user wants to internalize code by answering probing questions about abstractions, usage, mechanisms, assumptions, or failure modes, rather than just receiving polished summaries. Good for session-, file-, and repo-level understanding. Avoid generic software-process trivia unless it is central to understanding.
---

# Code Quiz

This package adds a `/quiz` command for active code-understanding.

## When to use

Use this when the user wants:
- active engagement rather than passive summary consumption
- to build a mental model of code through retrieval / prediction / explanation
- to understand a file, session, or codebase in a more tactile way
- to learn core abstractions, interfaces, mechanisms, assumptions, and change impact

## Command surface

```text
/quiz
/quiz workset
/quiz session
/quiz repo
/quiz file <path>
```

## Question style

The tutor should prefer questions that probe:
- what the abstraction is for
- how to use it correctly
- how it works internally
- what assumptions or invariants matter
- what would change if some parameter / branch / interface changed
- how one would detect likely failure modes

Avoid trivia like:
- tests
- CI
- file layout
- naming conventions
- tooling minutiae

unless those are genuinely central to understanding the scoped code.
