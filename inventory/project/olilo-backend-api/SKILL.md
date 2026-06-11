---
name: olilo-backend-api
version: 0.1.0
description: Understand and integrate with the Olilo backend API for financial data and entities.
---

# Olilo Backend API Integration

This skill helps you understand how to communicate with the Olilo backend API.

## Resources

- **[API Documentation](./api_usage.md)**: Detailed reference for all available endpoints, parameters, and response types.
- **Backend Check Script**: A utility to verify if the backend service is running.

## Usage Guide

### 1. Connecting to the Backend

The SvelteKit application connects to the backend via `src/lib/server/api.ts`.
- Uses `BACKEND_URL` environment variable (default: `http://localhost:8001`).
- **Authentication**: Most requests require the user's session cookie. Use the `buildCookieHeader` helper or pass `request.headers.get('cookie')` when making server-side fetches.

### 2. Common Patterns

When adding new API calls in SvelteKit `+page.server.ts` or `+server.ts` files:

```typescript
import { env } from '$env/dynamic/private';

// 1. Get the session cookie
const cookieHeader = event.request.headers.get('cookie');

// 2. Fetch from backend
const response = await event.fetch(`${env.BACKEND_URL}/api/v1/endpoint`, {
    headers: {
        Cookie: cookieHeader ?? ''
    }
});
```

### 3. Check Backend Status

You can use the included script to verify if the backend is reachable from your environment.

```bash
node check_backend.js
```
