---
name: deployment-strategy
description: >
  Plan deployment strategy including blue-green, canary, rolling, and feature flag
  approaches. Activate for Tier 3 changes that cannot be deployed atomically, carry
  production risk, or require coordinated rollout across environments.
---

# Deployment Strategy

## Related Skills
- **production-readiness:** Required for monitoring during rollout and cross-service coordination.
- **failure-analysis:** For partial rollout and rollback scenarios.

## Checklist

- [ ] Deployment strategy chosen and documented in spec
- [ ] Rollback trigger defined (what condition triggers rollback?)
- [ ] Rollback procedure tested
- [ ] Health checks defined
- [ ] Monitoring dashboard identified or created
- [ ] Canary/rollout percentage planned (if gradual)
- [ ] Feature flag configured (if progressive delivery)
- [ ] Environment promotion order defined (dev → staging → prod)
- [ ] Blast radius per environment assessed

## Gotchas

- Feature flags without a cleanup date become permanent tech debt. Set a removal date when creating the flag.
- Health check endpoints that return 200 as long as the web server runs (even if the database is down) will pass canary checks while the service is broken. Use deep health checks that verify dependencies.
- Canary metrics compared against wrong baselines (e.g., comparing weekend canary traffic to weekday baseline) produce false confidence.

## Patterns

### Default: Canary with rollback triggers
Use canary deployment for most changes. Route 5% → 25% → 100%, monitoring at each step. This gives production validation with limited blast radius.

**Rollback triggers** (define these before deploying):
- Error rate > X% above baseline
- P99 latency > Yms
- Business metric drops by Z%

Use **feature flags** when you need to decouple deploy from release (instant rollback by disabling flag). Use **blue-green** only when you need full environment testing before switching.

## Validation Loop

At each canary percentage:
1. Compare error rate and latency against baseline
2. If metrics are within thresholds, increase percentage
3. If metrics degrade, halt and investigate before proceeding
4. Only go to 100% after all thresholds pass at 25%+

```bash
# Check canary error rate
curl -s "https://metrics/api/error_rate?service=api&version=canary" | jq '.rate'

# Health check
curl -f https://api/health || echo "Health check failed"
```

## Anti-Patterns

- **"We'll just redeploy"** — if rollback isn't tested, it doesn't work.
- **0% to 100%** — always canary with intermediate percentages.
- **Skipping staging** — promote through environments.
