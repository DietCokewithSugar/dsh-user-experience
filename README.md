[English](README.md) · [简体中文](README.zh.md)

# dsh-user-experience

> A UX walkthrough plugin for DeepSeek Harness (DSH): **finds potential UX issues in your project — automatically walks through React/TypeScript source code, pinpoints problems, and suggests fixes.**
>
> v0.1 scope: React + TypeScript source only, static evidence only, no visual issues.

Existing automated checks (axe, Lighthouse) can only verify absolute rules — contrast ratio, missing alt text. But UX issues are inherently **relative**: a confirmation dialog before deleting protects an occasional user but wastes the time of an operator who processes hundreds of records a day. Without knowing *who it's for*, a "UX issue" cannot be defined.

This plugin makes **target user personas** a prerequisite for the walkthrough: every finding is anchored to an explicit persona, and no persona means no conclusions. The walkthrough produces actionable, locatable, reviewable UX hints **during development** — not post-launch user feedback.

---

## Scope (explicitly out of scope in v0.1)

- **React + TypeScript** source only (clearly reports unsupported when another stack is detected)
- Evidence level is fixed at **static** (source-code evidence); **no visual issues**: contrast, hit-target size, text truncation, focus order
- No auto-fix, no code changes: suggestions only ("a nudge for the developer to look", not a verdict)
- Input is source code only; website input (v0.2) and design-mockup input (v0.3) are reserved roadmap items

## Features

| Capability | Entry point | Description |
|---|---|---|
| Persona init | `/ux init` | The model generates 1–3 persona drafts from README / package.json / route structure and writes them to `.ux/personas.yml` **after user confirmation**; loads directly when the file already exists, without re-asking |
| Persona context injection | automatic | Injects the active personas and walkthrough protocol into every request for the current project (aligned with the AGENTS.md section-provider pattern) |
| Source walkthrough | `/ux scan` | Confirms scope first (architecture docs take precedence, otherwise asks for the feature/flow), then walks each persona independently and merges into one report; 9 high-confidence rules, model judgment first with AST verification as support |
| Finding confirmation loop | report card | Every finding carries a locator and Confirmed / Rejected buttons; verdicts are written to the session log and fully restored on replay |
| Report output | automatic | Markdown sorted P0→P3, common issues (hit by ≥2 personas) first; only confirmed findings count in the final list |
| Glossary | automatic | R-02 term verdicts persist incrementally to `.ux/glossary.yml`; later rounds only compare deltas |

### The 9 rules (v0.1)

| ID | Rule | Verification path |
|---|---|---|
| R-01 | Error message without actionable guidance | model (AST only extracts error-branch copy) |
| R-02 | Inconsistent terminology (conditional: only when the round has no P0/P1) | model (AST only extracts candidate locations) |
| R-03 | Generic wording for irreversible actions | model |
| R-04 | Irreversible action without a confirmation step | model+ast |
| R-05 | Loading state without empty state | model+ast |
| R-06 | Success state without error state | model+ast |
| R-07 | Submit button not disabled while submitting | model+ast |
| R-08 | No fallback for long/overflow content | model+ast |
| R-09 | Dark/light mode adaptation missing | **ast** (fast lane, zero tokens) |

Severity is derived from a matrix: `impact` (does it block the persona's critical task; given by the model) × `reach` (share of target users affected; derived from the sum of `share` of hit personas, ≥0.5 is wide) → P0/P1/P2/P3.

### Repository file conventions

| File | Committed to git | Description |
|---|---|---|
| `.ux/personas.yml` | ✅ committed | Project-level consensus, team-shared; CI mode depends on it |
| `.ux/glossary.yml` | ✅ committed | Glossary and verdicts; high reuse value |
| `.ux/rules.local.yml` | ❌ gitignored (reserved in v0.1) | Personal walkthrough preferences (disable rules, focus areas, excluded dirs); not imposed on the team |

Recommended addition to the project's `.gitignore`:

```gitignore
.ux/rules.local.yml
```

---

## Installation

> ⚠️ **Security note (must read)**
>
> Plugins installed from GitHub **run a build script on your machine at install time** (this repo builds its publish artifacts from source via a `prepare` script; on first `add`, pnpm ≥ 10 also asks you to explicitly allowlist that build in your profile's `pnpm-workspace.yaml`). This amounts to **granting the package permission to execute code during installation**, outside the agent sandbox.
>
> Therefore:
> 1. **Only install plugins from sources you trust** — installing is executing;
> 2. **Pin a commit** so later pushes cannot silently change the code that runs at install time:
>
> ```sh
> dsh plugin --profile <your-profile> add github:DietCokewithSugar/dsh-user-experience#<commit-sha>
> ```
>
> If you'd rather not grant build permission, install the prebuilt artifact from npm: `dsh plugin add dsh-user-experience`.

After installation, the plugin row (id `ux-experience`) enters the configuration layer; restart `dsh` or reload the profile to take effect. Available config options (overridden by id in the profile's `cordis.patch.yml` or the `--patch` layer):

```yaml
- id: ux-experience
  config:
    maxScanFiles: 300            # Max files collected per scan
    maxCandidatesPerRule: 5      # Max candidates per rule per file
    maxCandidatesPerFile: 25     # Total candidate cap per file
    maxFindings: 30              # Max findings per report
    excludePatterns: ['test', 'stories']   # Extra dirs to skip (on top of defaults)
```

## Usage

```text
/ux init                          # Initialize target personas (draft → confirm → write)
/ux scan Order flow from selection to payment   # Start a walkthrough (confirm scope first, then walk per persona)
# Click Confirmed / Rejected on each finding in the report card — only confirmed ones enter the final list
```

## Development

```sh
pnpm install
pnpm run build     # tsdown (host half + client bundle) + tsc (type declarations)
pnpm test          # smoke tests (AST engine / persona / glossary / matrix / end-to-end)
```

- **Version pinning**: DSH is in developer preview and its interfaces change. This repo pins `@deepseek-ai/dsh-*@0.1.0-rc.6` (`@deepseek-ai/cordis@4.0.1`); verify locally before upgrading the framework.
- Structure: `src/index.ts` is the Host plugin (commands + prompt injection + three model tools); `src/client/` is the Web client plugin (report card, discovered by the module table via the `dsh.client` declaration); one bundle row (`cordis.patch.yml`) mounts both.
- Red line: the agent loop is untouched — all capabilities hang on documented extension points (`ctx.commands` / `ctx.systemPrompt.section()` / `ctx.tools.register()` / `SessionEventMap`).

## Publish checklist

- [x] README security note (see Installation above)
- [x] README declares the v0.1 scope (source only, static evidence only, no visual issues)
- [x] Pinned DSH dependency versions (developer preview)
- [x] Repo has the **`dsh-plugin`** topic (official discovery mechanism)
- [x] PR to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), one line each in the English and Chinese READMEs (auto-synced to the site after merge) — [PR #63 merged](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/63), [copy update PR #66](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/66)
- [ ] Join the official Discord community (manual step; see the official docs/repo for the invite link)

## License

MIT
