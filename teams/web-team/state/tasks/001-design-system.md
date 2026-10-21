# Task 001: Core UI Design System & Component Tokens

> User verbatim instruction: "สั่งเขาออกแบบ systemdesign หน่อยอะไรก็ได้"

## Brief
Design a modern, cohesive UI Design System (called "Aurora UI") featuring a clean dark/glass aesthetic. Produce both the visual design file in FigCraft (`workspace/design-system/aurora-design-system.figcraft`) and a matching CSS/Tailwind design token specification (`workspace/design-system/tokens.css`).

## Known context
- `designer` has FigCraft MCP tools available (`mcp__figcraft__*`) connecting to `C:\Program Files\FigCraft\figcraft-cli.exe`.
- Git repository initialized at `workspace/design-system/`.
- Project conventions in `teams/web-team/AGENTS.md`.

## Spec
1. Define design tokens in `workspace/design-system/tokens.css`:
   - Color palette: Primary (Electric Violet/Indigo), Accent (Cyan/Teal), Surface (Dark neutral tones #0F172A, #1E293B), Semantic (Success, Warning, Danger).
   - Typography scale (xs to 4xl) and font hierarchy.
   - Spacing scale (4px, 8px, 12px, 16px, 24px, 32px, 48px).
   - Border radii (sm, md, lg, xl, full) and elevation shadow tokens.
2. In FigCraft (`workspace/design-system/aurora-design-system.figcraft`), construct a design system document containing:
   - A "Colors & Tokens" frame showcasing the color palette swatches and typography.
   - A "Components" frame with at least 3 core components:
     a. Button (Primary, Secondary, Ghost, Danger variants across Default and Hover/Active states).
     b. Input Field (Default, Focused with glow/ring, Error state).
     c. Card Component (Surface container with header, content area, and action footer).
3. Create a clean preview/spec Markdown summary at `workspace/design-system/README.md` detailing token usages and guidelines.

## Out of scope
- Backend APIs, server logic, database schemas, or state management.
- Complex third-party framework setups outside of pure CSS tokens and FigCraft assets.

## Verify
Both output files exist and are non-empty:
`test -s workspace/design-system/tokens.css && test -s workspace/design-system/README.md`

## Notes
Use `node tools/team.mjs --team web-team claim 001-design-system designer` before starting.
Log progress and release when done via `tools/team.mjs`.
Review will be performed by `reviewer` upon completion.
