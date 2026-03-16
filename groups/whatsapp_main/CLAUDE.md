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

## Knowledge Base

The knowledge base is an Obsidian vault at `/Users/viktor/Documents/Knowledge Base/` (accessible at that path inside the container via the Documents mount).

Structure:
- `Notes/` — Personal notes, ideas, journaling
- `Projects/` — Project docs, meeting notes, tasks (one subfolder per project)
- `Research/` — Summaries of articles, books, topics

When asked to save, look up, or summarise notes:
- Read relevant `.md` files to answer questions
- Create new notes using the format `YYYY-MM-DD Title.md` for dated notes, `Title.md` for evergreen ones
- Start each note with a short summary paragraph, then use `#tags` for topics
- When writing a research summary, include source, key takeaways, and your synthesis
