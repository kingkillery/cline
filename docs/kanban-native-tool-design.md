# Kanban Native Tool Design

## Summary

The current sidebar experience asks the selected agent to manage the board through appended instructions and raw CLI commands. That works, but it feels indirect and brittle. The native Kanban tool should replace prompt-wrangling with a first-class board authoring surface that lets users decompose work, create connected tasks, and shape handoffs as visible artifacts before anything is applied to the board.

This should still use the selected agent for reasoning. The change is in the interface and contract:
- the user edits a structured goal
- the agent returns a structured task graph
- Kanban renders that graph natively
- the user reviews and adjusts it
- Kanban applies it atomically

## Product Goal

Make "break this into tasks and wire the handoffs correctly" feel like a core Kanban action, not a clever prompt trick.

## Design Lenses

### Clarify

The tool must remove ambiguity around:
- what gets created
- which tasks depend on which others
- what each handoff contains
- what will auto-start and when

### Onboard

A first-time user should understand the value in one pass:
- enter a goal
- inspect the proposed graph
- adjust if needed
- apply to the board

The first-run experience should teach the graph model by demonstration, not by documentation.

### Polish

The surface should feel integrated with the existing board:
- same tokens, radii, borders, and typography
- compact, operator-grade layout
- motion that explains graph causality
- no generic chatbot framing

## Core Concept

Add a new left-rail section beside `Projects` and `Agent`:
- `Tool`

This section hosts a native Kanban workflow called `Build Task Graph`.

The `Agent` section remains for open-ended discussion.
The `Tool` section is for structured task authoring.

## Primary Jobs

1. Decompose one large goal into well-scoped tasks.
2. Create dependency edges with correct semantics.
3. Generate handoff packets for downstream tasks.
4. Apply the graph to the board in one atomic action.
5. Let the user review and edit before creation.

## Information Architecture

The tool uses a three-pane layout inside the sidebar surface when expanded.

### Pane 1: Goal Composer

Purpose:
- define the parent goal
- set graph-level defaults
- attach source context

Fields:
- `Goal`
- `Success condition`
- `Constraints`
- `Relevant files / issues / docs`
- `Default base ref`
- `Automation preset`
- `Planning mode default`

Primary actions:
- `Generate graph`
- `Load example`

### Pane 2: Graph Canvas

Purpose:
- render the proposed task graph as native Kanban nodes and edges
- let users adjust structure before creation

Node contents:
- short title
- one-sentence outcome
- status badge: `Draft`, `Blocked`, `Ready`
- prerequisite count
- handoff badge
- automation badge

Supported interactions:
- drag to reorder layout
- click edge to inspect dependency
- click node to inspect/edit details
- add prerequisite
- remove prerequisite
- duplicate node
- split node
- merge nodes

Visual model:
- prerequisites feed into the dependent task
- blocked nodes show a compact lock badge like `2 blockers`
- ready nodes feel brighter and slightly raised

### Pane 3: Inspector

Purpose:
- edit the selected node without leaving the graph
- make handoffs explicit

Sections:
- `Task`
- `Depends on`
- `Hands off to`
- `Handoff packet`
- `Execution defaults`

Editable task fields:
- title
- full prompt
- acceptance criteria
- relevant file refs
- base ref override
- start in plan mode
- auto-review setting

Editable handoff packet fields:
- why this task exists
- what downstream tasks need to know
- expected outputs
- likely touched areas
- validation required before handoff

## Handoff Model

Handoffs should be visible and authored as first-class objects.

Each dependency edge gets an optional handoff packet with:
- `Context`
- `Output expected`
- `Files / surfaces likely affected`
- `Validation gate`
- `Risks to watch`

In the graph UI, edges with strong handoff data show a small packet icon.
Selecting the edge opens the handoff details in the inspector.

## Key Flows

### Flow 1: First-Time User

1. User opens `Tool`.
2. Empty state explains the value:
   - "Turn one goal into a task graph with explicit dependencies and handoffs."
3. User sees a short example graph.
4. User enters a goal and clicks `Generate graph`.
5. Proposed nodes fan into view.
6. User edits one node and applies the graph.

### Flow 2: Power User

1. User pastes a large implementation goal.
2. Tool generates 5-12 tasks.
3. User quickly adjusts edges and automation presets.
4. Footer shows exact result:
   - `Create 8 tasks, 9 links, 3 handoff packets`
5. User clicks `Apply to board`.

### Flow 3: Handoff Repair

1. User selects an existing blocked task.
2. Opens `Tool` in `Repair graph` mode.
3. Tool imports the current task neighborhood.
4. User adds a missing prerequisite or edits the handoff packet.
5. Changes apply without recreating the whole graph.

## Empty State

This surface needs a strong empty state because it introduces a new mental model.

Headline:
- `Build a task graph`

Body:
- `Use the selected agent to decompose a goal into connected Kanban tasks with explicit handoffs and unblock rules.`

Actions:
- `Generate from a goal`
- `Use example graph`

The example should show:
- one prerequisite
- two parallel tasks
- one final integration task

## Visual Direction

### Tone

Serious, compact, and alive.

This should feel closer to a code review or dependency planner than to a chat thread.

### Layout

- Use the existing dark surfaces from `globals.css`
- Keep panel density high
- Favor 12px to 13px UI text with strong hierarchy
- Use accent blue sparingly for active structure, not decoration

### Node Styling

- Draft nodes: `surface-2`
- Selected node: accent outline
- Ready node: slightly brighter surface with blue status chip
- Blocked node: muted with lock count
- Risky node: orange edge or chip, not full-card warning color

### Edge Styling

- Default edge: accent blue line
- Selected edge: brighter, thicker line
- Incomplete prerequisite groups: subtle dashed segment on dependent side
- Handoff-rich edges: tiny packet marker at midpoint

## Motion

Motion should explain causality.

Use:
- fan-out animation when a generated graph appears
- pulse-through-edge animation when a prerequisite is satisfied
- subtle inspector slide when switching node focus

Avoid:
- bounce
- playful spring effects
- ornamental idle animations

Respect reduced motion by replacing animations with state fades and clear badges.

## Copy Direction

The tool should use direct, concrete language.

Prefer:
- `Generate graph`
- `Apply to board`
- `Blocked by 2 tasks`
- `Handoff required`
- `Ready after review`

Avoid:
- vague AI language
- "magic" framing
- generic assistant phrasing like `How can I help?`

## Apply Footer

The footer is critical because it converts design into trust.

It should always show:
- how many tasks will be created
- how many links will be created
- whether any tasks are blocked
- whether handoff packets are missing

Primary CTA:
- `Apply to board`

Secondary CTA:
- `Copy JSON`

Tertiary:
- `Send to Agent chat`

`Copy JSON` matters for debugging and trust.

## Error States

The tool should fail visibly and concretely.

Examples:
- `This graph contains a dependency cycle. Remove one of the highlighted edges.`
- `Two tasks have no actionable outcome yet. Add acceptance criteria before applying.`
- `3 handoffs are empty. Downstream tasks will have weak context.`

## Accessibility

- Keyboard support for node selection and inspector editing
- Edge selection must have a keyboard-accessible alternative through a dependency list
- Never rely on color alone for blocked vs ready
- All graph states need text labels or counts
- Maintain WCAG AA contrast on node chips and edge-highlight states

## MVP Recommendation

Ship this in two stages.

### Stage 1

Native graph authoring in the sidebar:
- goal composer
- graph preview
- inspector
- apply footer

No canvas-heavy freeform layout yet. A structured vertical graph/list hybrid is enough.

### Stage 2

Add richer graph manipulation:
- repair mode for existing tasks
- imported current-board neighborhood
- stronger edge editing
- handoff quality scoring

## Success Criteria

The design is working if:
- users can create multi-task graphs without manual CLI reasoning
- dependency mistakes drop sharply
- downstream tasks start with richer context
- first-time users understand the feature from the empty state alone
- the surface feels native to Kanban, not like an embedded chatbot workaround
