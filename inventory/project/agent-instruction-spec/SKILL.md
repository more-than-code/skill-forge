---
name: agent-instruction-spec
version: 0.1.0
description: Guidelines and specifications for creating agent instructions and prompt files.
---

# Agent Instruction Specifications
To maintain consistency and clarity across all project documentation, please adhere to the following guidelines when creating or updating markdown files in this repository.

## Instructions Files
1. **YAML Front Matter**: Each instructions file must begin with a YAML front matter section that includes:
   - `description`: A brief summary of the instructions.
   - `applyTo`: One or more glob patterns specifying which files the instructions apply to.

## Prompt Files
1. **YAML Front Matter**: Each prompt file must begin with a YAML front matter section that includes:
   - `agent`: The type of agent the prompt is intended for.
   - `description`: A brief summary of the prompt's purpose.
   - `tools`: A list of tools that the agent can use to fulfill the prompt.
