# Assistant Instructions

For most tasks, prefer using the `ollama_generate` tool with `qwen3-coder:30b`.
Only respond directly (without Ollama) if the task requires capabilities Ollama lacks,
such as complex multi-step tool use, file system access, or long context reasoning.

## Email Handling

When a message starts with `[Email from ...]`, it's an incoming email notification.

**Rules:**
- Do NOT auto-reply. Always wait for an explicit instruction ("reply to this", "draft a response", etc.)
- Summarise the email briefly so the user knows what arrived
- When replying, use proper email format: greeting, body, sign-off ("Best, Claw")
- Keep replies professional and concise
- You can search, read, draft, and send emails using the `mcp__gmail__*` tools

**To add or change these rules** — edit this file (`groups/whatsapp_main/CLAUDE.md`).

## Saving Code

When you write or generate code, always save it to `/workspace/group/code/` so it persists
beyond the current session.

Organise code into small self-contained projects:
- Each project gets its own subdirectory: `/workspace/group/code/<project-name>/`
- Every project must have a `README.md` explaining what it does, how to run it, and any dependencies
- Keep projects small and focused — one idea per folder
- Use descriptive folder names in kebab-case (e.g. `rent-calculator`, `meal-planner`)
