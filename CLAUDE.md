@AGENTS.md

# Project context

The specs for this project live in `context/`. Read them before you write code for a new feature, a bug fix, an error or an
improvement, and follow them. If a request conflicts with them, say so before you build anything.

`context/current-state.md` is loaded below. It says what is built, the known gaps and what comes next:

@context/current-state.md

## What to read for each kind of task

| Task | Read first |
|---|---|
| Any task | `context/current-state.md` (above) |
| New feature | `context/project-overview.md`, `context/architecture.md`, `context/ui-design.md`, and its spec in `context/features/` |
| Bug fix or error | `context/architecture.md` for the module involved, plus the spec for its feature in `context/features/` |
| Improvement or refactor | `context/architecture.md`, plus `context/ui-design.md` if it touches the UI |
| Any UI work | `context/ui-design.md` |
| Anything that reads or changes `mock-data/` | `context/mock-data.md` |
| Gmail ingestion (Feature 1) | `context/features/feature-1-gmail-price-list-ingestion.md` |

## Rules

- **Plan before you build.** Features 2, 3 and 4 get their own spec in `context/features/` before any code is written,
  as `current-state.md` §6 says.
- **Check open decisions.** If a task depends on something listed in `architecture.md` §12, ask the user to decide it
  rather than picking an answer silently.
- **Stick to the architecture.** Route handlers validate input, call one service and map errors. Business logic stays in
  pure functions under `lib/`. Data lives in local JSON under `mock-data/`, with no database.
- **Keep the UI consistent with `context/ui-design.md`.** Every screen follows its screens, states, copy, colour tokens,
  type, layout sizes, shadcn components and behaviour rules (§8). Reuse the existing shell components rather than
  inventing new patterns. If the build has to change or add to the design, write that back into `ui-design.md` in the
  same change.
- **Keep the context current.** When a change alters what is built, a known gap, the next steps or a design decision,
  update the matching file in `context/` in the same change. Always update `current-state.md`, including its
  "Last updated" date and the numbers in "What runs today".
- **Verify before you call it done.** Run `bun run test`, `bun run lint`, `bunx tsc --noEmit` and, for larger changes,
  `bun run build`.
