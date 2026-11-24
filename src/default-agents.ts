/**
 * default-agents.ts — Embedded default agent configurations.
 *
 * These are always available but can be overridden by user .md files with the same name.
 */

import type { AgentConfig } from "./types.js";

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

export const DEFAULT_AGENTS: Map<string, AgentConfig> = new Map([
  [
    "general-purpose",
    {
      name: "general-purpose",
      displayName: "Agent",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
      // builtinToolNames omitted — means "all available tools" (resolved at lookup time)
      // inheritContext / runInBackground / isolated omitted — strategy fields, callers decide per-call.
      // Setting them to false would lock callsite intent (see resolveAgentInvocationConfig in invocation-config.ts).
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      isDefault: true,
    },
  ],
  [
    "Explore",
    {
      name: "Explore",
      displayName: "Explore",
      description: "Fast read-only search agent for locating code. Use it to find files by pattern (eg. \"src/components/**/*.tsx\"), grep for symbols or keywords (eg. \"API endpoints\"), or answer \"where is X defined / which files reference Y.\" Do NOT use it for code review, design-doc auditing, cross-file consistency checks, or open-ended analysis — it reads excerpts rather than whole files and will miss content past its read window. When calling, specify search breadth: \"quick\" for a single targeted lookup, \"medium\" for moderate exploration, or \"very thorough\" to search across multiple locations and naming conventions.",
      builtinToolNames: READ_ONLY_TOOLS,
      extensions: true,
      skills: true,
      // No model/thinking pin. An embedded default must not name a provider ID:
      // on a machine without that provider every bare Explore spawn would fail,
      // and the machine could not fix it without editing the extension. The
      // level and model come from the machine-owned `agentOverrides` in
      // subagents.json (the `/subagents` menu) or from an agent .md's
      // frontmatter; with neither, the spawn inherits the parent session model.
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Make independent tool calls in parallel for efficiency
- Adapt search approach based on thoroughness level specified

# Output
- Use absolute file paths in all references
- Report findings as regular messages
- Do not use emojis
- Be thorough and precise`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
  [
    "Plan",
    {
      name: "Plan",
      displayName: "Plan",
      description: "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
      builtinToolNames: READ_ONLY_TOOLS,
      // Read-only work is the strongest codemode case: a plan sweeps dozens of files across
      // many patterns, and one script collapses that into a single turn. Any ext: entry flips
      // extension tools to an allowlist, so fast-search is named to keep the fast grep/find.
      extSelectors: ["ext:builtin:codemode", "ext:fast-search"],
      extensions: true,
      skills: true,
      systemPrompt: `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.
You do NOT have access to file editing tools — attempting to edit files will fail.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly (read files, find patterns, understand architecture)
3. Design solution based on your assigned perspective
4. Detail the plan with step-by-step implementation strategy

# Requirements
- Consider trade-offs and architectural decisions
- Identify dependencies and sequencing
- Anticipate potential challenges
- Follow existing patterns where appropriate

# Tool Usage
- Use the find tool for file pattern matching (NOT the bash find command)
- Use the grep tool for content search (NOT bash grep/rg command)
- Use the read tool for reading files (NOT bash cat/head/tail)
- Use Bash ONLY for read-only operations
- Batch a sweep into one \`codemode\` script (only when that tool is present: the Claude Code
  backend has none unless its experimental Code Mode is on, so combine the sweep into fewer
  \`bash\` calls there instead): on the second
  consecutive \`read\`, \`grep\` or \`bash\` call for the same question, write one script that
  does the whole step —
  \`Promise.allSettled\` over \`tools.read\` / \`tools.grep\`, then \`text()\` only what answers
  it. \`tools.bash\` inside a script returns up to 1 MiB against the 50 KB a direct call shows.
- Never run a program through bash: no \`python3 -c\`, no python heredoc, no \`node -e\`, no
  \`jq\`/\`sed\`/\`awk\` pipeline standing in for logic. That is a \`codemode\` script.
- Scripts are read-only too: \`tools.read\`, \`tools.grep\`, \`tools.find\` and read-only
  \`tools.bash\` only. Never \`tools.write\`, \`tools.edit\`, or a state-changing command.

# Output Format
- Use absolute file paths
- Do not use emojis
- End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- /absolute/path/to/file.ts - [Brief reason]`,
      promptMode: "replace",
      isDefault: true,
    },
  ],
]);
