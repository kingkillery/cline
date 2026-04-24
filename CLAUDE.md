@AGENTS.md

## Design Context

### Users
Kanban is for technical operators: software engineers, agent-heavy builders, and repo owners coordinating multiple coding agents inside active git repositories. They use it while under real delivery pressure, often juggling parallel tasks, review loops, and branch hygiene. The core job is to turn ambiguous work into an understandable task graph, monitor progress, and preserve confidence when automation hands work from one task to the next.

### Brand Personality
Technical, lucid, kinetic.

The interface should feel like a serious developer instrument rather than a consumer productivity app. It should evoke confidence, momentum, and oversight. Automation should feel powerful, but never mysterious.

### Aesthetic Direction
Dark-mode control room. Preserve the existing surface hierarchy, blue accent, dense information layout, and precise, tool-like tone. Favor structured panels, graph overlays, inline inspectors, and restrained motion that reinforces system state.

Reference qualities:
- observability dashboards
- modern terminal tooling
- code review interfaces

Anti-references:
- generic chatbot shells
- soft, playful SaaS boards
- pastel productivity apps
- oversized empty-state-heavy layouts

### Design Principles
1. Show structure, not magic.
2. Keep the operator in control.
3. Prefer graph editing over prompt wrangling.
4. Make handoffs explicit artifacts, not hidden session state.
5. Preserve density without sacrificing legibility.
6. Use motion to explain causality, not decorate the screen.

### Accessibility
Target WCAG 2.1 AA contrast and keyboard accessibility for all core flows. Reduced-motion accommodations should preserve comprehension of dependency and handoff state changes without relying on animation alone.
