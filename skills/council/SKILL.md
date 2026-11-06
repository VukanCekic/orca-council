---
name: council
description: Run a blind council on a decision, a deliverable or a fact report. Claude, GPT (Codex CLI) and Gemini (agy) answer the same brief independently, then a blind Claude chair judges the shuffled answers. Use when the user says "/council decision|deliverable|facts <what>", "council this", "get a second opinion from the other models", or asks for a multi-model review of a plan, deliverable or fact report. Not for code diffs, and never as proof that a file works.
---

# Council

A thin wrapper around `runner/council.mjs` in the Council plugin repository (call its folder `<council>`). The
runner does the work: members in parallel, answers shuffled into A/B/C, the blind chair, unseal, log. This skill
only writes the brief, runs the runner and presents the verdict.

| Mode | For | Members |
|---|---|---|
| `decision` | Plans, architecture, tool choices | claude + codex + agy, blind chair |
| `deliverable` | Anything before it reaches a client or users | same, plus a reminder that real checks are still needed |
| `facts` | Research reports before acting on them | codex fact-checks, claude triages. `--full` for all three |

## 1. Write the brief

Write it to a temporary file, never into the councils folder (the runner copies it there).

```markdown
# <short title: becomes the folder name>

## Question
<the one question, stated so a stranger could answer it>

## Context files
- <path>   (each one is also passed with --context, so it is inlined)

## What good looks like
<what a useful answer must contain>
```

Keep context files few. The member prompt is capped at about 25k characters (agy takes it as a command-line
argument); longer files are truncated and the verdict says so.

## 2. Run it

```bash
node <council>/runner/council.mjs decision --brief <brief.md> --context <file1> --context <file2> --project <project folder>
```

- A typical run takes 3 to 4 minutes; each engine has a 15 min timeout (`--timeout`). Run it in the background.
- It costs one call per member plus one chair call on the user's own subscriptions. Don't rerun to "get a better verdict".
- Exit 0 = verdict written (also when degraded). 2 = no member answered. 3 = the chair failed.
- Inside an Orca terminal the runner opens the live Council tab itself. Elsewhere it prints the `orca file open` line.
- `node <council>/runner/council.mjs doctor` shows which CLIs it can find. Missing members are skipped and named in the verdict.

## 3. Present the verdict

Read `<root>/<date>-<slug>/verdict.md` (the runner prints the path) and reply in this order:

1. **● Needs you**: the chair's list. This is why the council ran.
2. The chair's **TL;DR**, the **Verdict** line and **Confidence**. Quote the members' one-line TL;DRs in a short table when they disagree.
3. Any **⚠ warnings** (a member that failed, timed out, hit a limit or was skipped; truncated context). Two answers out of three is a degraded council: say so. One answer is not a council.
4. The unsealed mapping (who was favoured) in one line, last.

Never edit `sealed.json` or the answers, and never show the mapping to a chair.
