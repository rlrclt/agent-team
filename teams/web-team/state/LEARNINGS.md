# Team Learnings & Past Human Corrections

This file holds permanent lessons and rules taught by the human to prevent repeating past mistakes.
Every agent must follow these rules. Reviewers must fail code that violates them.

- [general] Read task spec via `node tools/team.mjs view <id>` before acting; never guess or assume requirements. (taught: 2026-10-18)
- [code] English for code, identifiers, and comments. Thai is fine for human/orchestrator discussions. (taught: 2026-10-18)
- [scope] Never touch files outside your assigned role boundary (frontend stays in UI, backend stays in API/Server). (taught: 2026-10-18)
- [auth] Secrets and database connections must remain server-side. Never expose private credentials to client components. (taught: 2026-10-18)
- [components] Client components in Next.js App Router must have 'use client' at the leaf level only. (taught: 2026-10-18)
- [modal] All modal dialogs must trap focus and close on Escape key (taught: 2026-10-18)
