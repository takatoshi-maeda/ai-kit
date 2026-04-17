---
name: skill-creator
description: Guide for creating or updating a skill. Use when the user wants to add a new skill or revise an existing skill for this ai-kit app.
---

# Skill Creator

Create skills as a single file at `.skills/<skill-name>/SKILL.md`.

## Skill Format

Every skill should contain:

```markdown
---
name: skill-name
description: Explain what the skill does and when to use it.
---

# Skill Title

## Goal

[Goal for the agent]

## Instructions

[Instructions for the agent]
```

Rules:

- Use lowercase letters, digits, and hyphens for `name`.
- Keep the description specific about both behavior and trigger conditions.
- Put all trigger guidance in `description`, not in a separate "when to use" section.
- Keep the body concise and procedural.

## Workflow

1. Understand the concrete tasks the skill should help with.
2. Choose a short hyphen-case skill name.
3. Create or update `.skills/<skill-name>/SKILL.md`.
4. Write frontmatter with `name` and `description` only.
5. Write the body as instructions another agent can follow directly.
6. Refine the file after trying it on realistic requests.

## Editing Guidance

- Prefer one clear workflow over broad commentary.
- Include examples only when they improve triggering or execution.
- Avoid repeating obvious model knowledge.
- Do not create extra files as part of the default skill shape.

## Updates

When updating an existing skill:

- Preserve the skill name unless the trigger semantics changed.
- Tighten the description first if invocation is unreliable.
- Simplify the body before adding more detail.
