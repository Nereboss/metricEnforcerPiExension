AGENTS (for autonomous/code-assistant contributors)

Purpose
-------
This file tells AI agents and human contributors how to behave when making changes in this repository. It complements the project-specific plan in @plan.md and enforces standards for code quality, extensibility, maintainability and clarity.

Core principles
--------------
- DRY: Extract repeated logic into reusable functions
- Clean Code: Self-documenting code with clear intent
- SOLID: Single responsibility, open/closed, dependency inversion
- Expressive Naming: Descriptive names that reveal intent
- Fix Warnings: Never suppress, always resolve
- Consistent Style: Match existing patterns
- Comments: Use sparingly for complex business logic rationale. Prefer clear function names over comments
- Immutability: Prefer immutable data structures, especially in the model layer
- Explicit over implicit: Prefer explicit parameters and configuration rather than hidden global state
- Performance focus: prefer performant code over verbose code
- Prefer typed code, try to avoid generic types like "any" or "unknown". Add types for public APIs.

Agent behavior guidelines
-------------------------
- Read before writing: Always read @plan.md and the most relevant source files before making changes.
- Ask when unsure: If requirements are ambiguous, ask a clarifying question instead of guessing.
- Prevent future mistakes: When you made a mistake and the user corrects you, adjust this AGENTS.md file to avoid that mistake in the future.
- State updates: After making changes that affect design or plan, update @plan.md and this AGENTS.md if necessary.
- Keep public API docs up to date (README, README sections for extensions, examples).

Coding standards
----------------
- Parameter naming: Use consistent, descriptive names across related functions
- Keep modules small and focused; avoid huge files.

Testing
-------
- Tests must accompany new features and bug fixes. Unit tests for logic, integration tests for cross-module behavior.
- Aim for fast, deterministic tests. Avoid network or external dependency calls unless mocked.
- Include simple test data and fixtures. Keep tests readable and maintainable.

Design & extensibility
----------------------
- Prefer explicit extension points (interfaces, callbacks, plugin registries) over ad-hoc branching.
- Keep internal modules private; only expose what's necessary for extension.

Error handling & logging
------------------------
- Fail fast with meaningful messages. Avoid swallowing errors silently.
- Use structured logging for important runtime events and errors.
- Distinguish between user-facing and developer-facing errors; include actionable messages for users.
- Return or surface errors instead of calling process.exit in libraries.

Maintenance & debt
------------------
- When touching code for unrelated reasons, prefer to keep the change minimal and avoid bundling refactors.