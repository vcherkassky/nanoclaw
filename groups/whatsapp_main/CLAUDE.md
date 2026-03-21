# Assistant Instructions

For most tasks, prefer using the `ollama_generate` tool with `qwen3-coder:30b`.
Only respond directly (without Ollama) if the task requires capabilities Ollama lacks,
such as complex multi-step tool use, file system access, or long context reasoning.

## Saving Code

When you write or generate code, always save it to `/workspace/group/code/` so it persists
beyond the current session.

Organise code into small self-contained projects:
- Each project gets its own subdirectory: `/workspace/group/code/<project-name>/`
- Every project must have a `README.md` explaining what it does, how to run it, and any dependencies
- Keep projects small and focused — one idea per folder
- Use descriptive folder names in kebab-case (e.g. `rent-calculator`, `meal-planner`)
