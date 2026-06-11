---
name: page-render-inspector
version: 0.1.0
description: Inspect the rendered content of the web application to verify UI state or content.
---

# Page Render Inspector

This skill allows you to "see" the current state of the running web application by launching a headless browser and retrieving the text content of the page.

## When to use

Use this skill when you need to:
- Verify that a page is rendering correctly.
- Check the text content of a specific route.
- Debug UI issues by inspecting the rendered output.

## Prerequisites

1. The development server must be running (usually `npm run dev` or `npm run preview`).
2. Dependencies (Playwright) must be installed (`npm install`).
3. Playwright browsers must be installed (`npx playwright install chromium`).

## How to use

Run the included `inspect_page.js` script using Node.js from this skill directory. You can provide a specific URL as an argument, or it will default to `http://localhost:5173`.

```bash
node inspect_page.js [url]
```

### Examples

**View the home page (default):**
```bash
node inspect_page.js
```

**View a specific route (e.g., /about):**
```bash
node inspect_page.js http://localhost:5173/about
```

**View the production preview (port 4173):**
```bash
node inspect_page.js http://localhost:4173
```
