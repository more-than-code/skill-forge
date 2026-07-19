---
name: llm-json-portable
description: >
  Portable convention for JSON-from-LLM over OpenAI-compatible Chat Completions without
  provider structured output. Use when building or reviewing LLM endpoints that must work
  across OpenAI-compatible providers, when tempted to use generateObject/JSON mode, when
  debugging fence-wrapped or quote-broken model JSON, or when the user mentions portable
  LLM JSON parsing.
---

# LLM JSON (portable)

Use this when the stack talks to an **OpenAI-compatible Chat Completions** API (OpenAI, DeepSeek, local gateways, etc.) and the JSON contract must stay **provider-portable**.

This is **not** the same as the global `llm-integration` skill (workflow validation, provenance, cost telemetry for agent pipelines). This skill is only about **getting a parseable JSON value out of model text**.

## Hard rule

Do **not** use provider structured output (`generateObject`, response `schema`, or forced JSON mode) if you need the same code path to work on arbitrary OpenAI-compatible backends. Those features diverge or are missing across providers.

**Do** use ordinary function/tool-calling when the product needs tools — that is a separate, usually portable surface.

## Recipe

1. **Prompt for JSON in text.** Use `generateText` (or equivalent) with a system prompt that states the exact shape and ends with: output **only** a single JSON object/array — no markdown, no code fences, no commentary.
2. **Never pin locale on the whole response** when the contract is JSON. "Respond in Chinese" → prose. Scope language instructions to a **named free-text field** ("`feedback` must be written in {locale}").
3. **Ban straight `"` inside free-text fields** in the prompt (prefer `「」` / `“”` / parentheses). Unescaped quotes are the #1 real-world parse failure.
4. **Parse defensively**, never `JSON.parse(raw.trim())` alone:
   - strip ``` / ```json fences
   - slice to the outermost `{...}` or `[...]`
   - normalize bare `undefined` → `null` if models emit it
   - optionally repair unescaped quotes inside string values, then parse
5. **Validate after parse** (types, required keys, domain allowlists). Invalid → safe error to the client; do not silently invent structure. (See also `llm-integration` for pipeline-grade validation.)

## Checklist

- [ ] No `generateObject` / JSON-mode dependency on the critical path
- [ ] Prompt shows the exact schema and "JSON only"
- [ ] Locale/language instructions scoped to free-text fields
- [ ] Free-text fields told to avoid raw `"`
- [ ] Shared extract+parse helper used (not one-off `JSON.parse`)
- [ ] Post-parse validation / normalization before persistence or UI

## Anti-patterns

- **Structured-output lock-in** for a multi-provider deployment
- **Top-level "answer in {language}"** on a JSON endpoint
- **Hand-rolled trim+parse** that dies on the first fence or inner quote
- **Trusting the model** without shape validation after parse

## Project overlays

This skill reaches consumer repos as a registry dependency, vendored by `skf sync`. Repos that want concrete helper paths and model tiers should add a companion skill under a **different name** (e.g. `llm-json-responses`) declared in `skill-forge.json` `skills.local`, pointing back here for the portable rules. Prefer the companion for repo specifics; use this skill when bootstrapping a new service or reviewing cross-repo portability.
