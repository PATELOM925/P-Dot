# P-Dot

A planned personal assistant with a web interface, a Vercel-hosted backend, Nebius model inference, and Tavily web search.

**Current status: documentation and directory structure only. No application code, dependencies, or deployment have been created.**

## Start here

- [Product requirements](docs/PRD.md): MVP scope, user journeys, acceptance criteria, and open decisions.
- [Architecture](docs/ARCHITECTURE.md): planned stack, folder map, provider boundaries, and deployment approach.
- [Shared agent instructions](AGENTS.md): repository rules and current phase restrictions.
- [Claude instructions](CLAUDE.md) and [Codex instructions](CODEX.md): tool-specific guidance.

## Structure

| Path | Intended purpose |
| --- | --- |
| `src/app/` | Frontend routes and Vercel API entry points |
| `src/components/` | Shared UI and layout components |
| `src/features/` | Authentication, chat, and settings features |
| `src/server/` | Private backend services and provider integrations |
| `src/lib/`, `src/types/` | Shared utilities and contracts |
| `public/` | Static assets |
| `tests/` | Future unit, integration, and end-to-end tests |
| `docs/` | Requirements, architecture, and decision records |

Empty directories use `.gitkeep` files so Git retains the skeleton.

## Configuration plan

`.env.example` lists the intended AI provider settings without credentials. Authentication and database settings will be added after those providers are selected. Never commit real secrets or expose Nebius/Tavily keys through client-visible environment variables.

## Next step

Review the PRD and select the authentication/database provider and Nebius model. Once implementation is requested, initialize the framework and document the actual install, development, validation, and deployment commands here. There is currently nothing to install or run.
