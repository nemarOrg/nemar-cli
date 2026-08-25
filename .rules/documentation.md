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