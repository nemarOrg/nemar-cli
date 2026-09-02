# Documentation Standards

> NEMAR's user-facing docs now live in their own repo, [nemarOrg/docs](https://github.com/nemarOrg/docs) (Astro Starlight), published at https://docs.nemar.org. This repo no longer hosts a docs site. The tool-specific setup below is retained only as general doc-writing guidance; do not reintroduce a MkDocs/Python pipeline here.

## [STRICT] A copied comment is a claim, not decoration

**Why:** the most severe defect found in this codebase's recent review history was
not in code. It was a justification comment copied from a module where it was
true into one where it was false, which turned a mild convergence bug into silent
data loss. Three code-focused reviewers read the same lines and missed it.

**The rule:** when you copy a comment along with a pattern, re-derive whether it
still holds. State the reason, not just the behaviour, so the next person can
check it against their context.

**Where this bites:**
- A safety claim citing a branch that is not the branch that runs
  ("re-probing is idempotent because the no-sidecar branch preserves prior
  values" -- when a populated row takes the *success* branch, which did not).
- A justification true for a one-time backfill, reused in a sweep whose
  candidate set recurs ("a brand-new row has no prior good values to protect").
- An error message inherited from a caller with different failure modes
  ("is migration NNNN applied?" reported for a credential failure).
- A rule quoted as a description of current state when the codebase says
  otherwise -- ADR 0027 is raw-only *going forward*, not a claim about what is
  in the bucket today.

**Never write "guarantees" for something the code defensively handles.** If there
is a fallback for the violation six lines below, it is not a guarantee.

## [STRICT] A claim in a plan is a claim in the code

**Why:** the rule above kept being violated by people who had read it. The reason
is that the false claim did not originate in the comment. It originated one step
upstream, in an approved plan or an implementer brief, and was copied down
verbatim because **nobody re-derives a confident line in an approved plan.**
Approval reads as verification. It is not: a plan is approved for its *approach*,
not fact-checked line by line.

Four instances in epic #1144 alone, each true where it was written and false where
it landed:

| Claim | True of | Landed in |
|---|---|---|
| `count` describes the population `results` is sliced from | nothing; the subquery is unbounded | code comments + a `.context` doc |
| `--rate` filters a column that is 0% until the sweeps run | `--duration`, `--recordings` | **ADR 0032**, which is binding |
| pair null test is AND because the pair is "written atomically" | `recording_duration`, `channel_count` | `age_min/max`, which predates that sweep |
| the null guard prevents "a fabricated processed=0 line" | nothing; the summary is already gated | six places, from one brief sentence |

**The rule, for whoever writes the plan:** a statement about how existing code
behaves is a claim you own. Verify it against the code before it goes in, or mark
it explicitly as unverified so it gets checked instead of copied. "Verify claims
about EXISTING behaviour against the base code before writing them into a plan"
was already recorded as a lesson after phase 1 of that epic, and was then violated
three more times by the same author.

**The rule, for whoever implements it:** a plan is not a source. When it states a
fact about the codebase and you are about to repeat that fact in a comment, an
ADR, or a commit message, re-derive it first. Disagreeing with an approved plan on
a point of fact is the cheapest correction available; the expensive one is a
binding ADR that is wrong.

**Watch the repetitive shapes.** All four instances were bulk edits: one sentence
applied to N sibling facets, N wrappers, N call sites. Structural repetition is
where a justification stops being re-read, so verify per instance, not per pattern.

## Core Philosophy: Write for Your Future Self
**Good docs** answer questions before they're asked.
**Think:** What would confuse me in 6 months?
**Goal:** New developers productive in <1 hour.

## Setup
**Install:** `pip install mkdocs mkdocs-material mkdocstrings[python]`  
**Config:** `mkdocs.yml` in project root

## Minimal mkdocs.yml
```yaml
site_name: {{PROJECT_NAME}}
site_url: https://example.com
repo_url: https://github.com/user/repo

theme:
  name: material
  features: [navigation.tabs, search.suggest]
  
nav:
  - Home: index.md
  - API: api/
  - Guides: guides/

plugins:
  - search
  - mkdocstrings:
      handlers:
        python:
          options:
            show_root_heading: yes
            members_order: source

markdown_extensions:
  - pymdownx.highlight
  - pymdownx.superfences
  - admonition
  - toc
```

## Structure
```
docs/
  index.md           # Home page
  guides/
    getting_started.md
    advanced.md
  api/               # Auto-generated from docstrings
    module_a.md      # Contains ::: my_project.module_a
```

## API Documentation
```markdown
# Module A
::: my_project.module_a
    handler: python
    options:
      show_source: no
```

## Commands
- **Develop:** `mkdocs serve` (live preview at localhost:8000)
- **Build:** `mkdocs build` (generates site/)
- **Deploy:** `mkdocs gh-deploy` (to GitHub Pages)

## Writing Tips (Think Like a Teacher)
- **Start with why:** Context before details
- **Show, don't tell:** Examples > explanations
- **Use admonitions:** `!!! warning "Common mistake"`
- **Code blocks:** Include full context, not fragments
- **Progressive disclosure:** Simple first, then advanced

**Ask yourself:**
- Would a new developer understand this?
- Did I explain the "why" not just the "how"?
- Are there examples for each concept?

## CI/CD Integration
See `ci_cd.md` for auto-deployment workflow

## Documentation Mindset
**You're not just documenting** - you're teaching.
**Every README** should get someone running in minutes.
**Every guide** should prevent a support question.
**Think:** "What would I want to know?"

---
*Great docs make great developers. Write with empathy.*