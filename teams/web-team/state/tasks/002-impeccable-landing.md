# Task 002: Impeccable Landing Page Design (Persuade Mode)

> User verbatim instruction: "ลองสั่งให้เขา ออกแบโดยใช้ skill /impeccable ลองออกแบบหน้า landingpage อะไรก็ได้"

## Brief
Design an award-winning, production-grade landing page for "Aetheria — Autonomous AI Infrastructure" adhering strictly to the `impeccable` skill principles (Persuade mode: bold POV, visual hierarchy, refined typography, flawless spacing, and high craft). Deliver both a FigCraft design canvas (`workspace/landing-page/landing.figcraft`) and a working standalone HTML/CSS presentation (`workspace/landing-page/index.html` + `workspace/landing-page/styles.css`).

## Known context
- `designer` has the `impeccable` skill (`~/.claude/skills/impeccable/SKILL.md`) and FigCraft MCP tools.
- Git repository initialized at `workspace/landing-page/`.
- Project conventions in `teams/web-team/AGENTS.md`.
- Mode: **Persuade** (earn attention, distinctive visual anchor, high contrast, crisp copy).

## Spec
1. Apply `impeccable` principles (Persuade mode):
   - Strong typographic hierarchy (display headings, clean body, mono accents).
   - Cohesive dark aesthetic with refined depth, subtle gradient glows, and razor-sharp borders.
   - Purposeful micro-copy (no generic lorem ipsum placeholder text).
2. Sections required:
   a. **Navigation Bar**: Brand logo, nav links (Product, Architecture, Benchmarks, Pricing), CTA button.
   b. **Hero Section**: High-impact headline, sub-headline, primary & secondary CTAs, social proof metric badges (e.g. 99.99% uptime, 10M+ ops/sec).
   c. **Feature Grid / Architecture**: 3 to 4 distinct feature cards showcasing key capabilities with iconography, titles, and descriptions.
   d. **Interactive / Visual Showcase Section**: Terminal/code preview or compute dashboard container.
   e. **Pricing / Call to Action**: Conversion card with clear tier breakdown or early-access form.
   f. **Footer**: Navigation links, legal, status badge.
3. Deliverables:
   - `workspace/landing-page/landing.figcraft`: FigCraft canvas with full Desktop (1440px) artboard.
   - `workspace/landing-page/index.html` & `workspace/landing-page/styles.css`: Working, beautiful, responsive standalone HTML/CSS implementation matching the design.
   - `workspace/landing-page/README.md`: Design rationale detailing layout choices, typography scale, and color scheme.
4. Export preview render:
   - Export PNG render of the FigCraft canvas using `figcraft-cli export workspace/landing-page/landing.figcraft -o workspace/landing-page/renders --format png --scale 2` or through FigCraft tools.

## Out of scope
- Server-side backends, databases, authentication, or external API integrations.

## Verify
`test -s workspace/landing-page/index.html && test -s workspace/landing-page/styles.css && test -s workspace/landing-page/README.md && test -s workspace/landing-page/landing.figcraft`

## Notes
- Claim before work: `node tools/team.mjs --team web-team claim 002-impeccable-landing designer`
- Release and log when done: `node tools/team.mjs --team web-team log 002-impeccable-landing designer done ...`
- Report back asynchronously to orchestrator via:
  `herdr agent prompt web-team-orchestrator "[designer done] task 002-impeccable-landing finished..."`
