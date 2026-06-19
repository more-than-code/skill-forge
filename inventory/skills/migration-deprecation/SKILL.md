---
name: migration-deprecation
description: >
  Plan and execute version migrations and contract deprecation across runtime, tests,
  docs, and consumers. Activate for Tier 3 changes that modify contracts with active
  consumers, version migrations (v1 to v2), or feature deprecation.
---

# Migration & Deprecation

## Related Skills
- **deployment-strategy:** Use together for production rollouts.
- **production-readiness:** Required for monitoring migration progress and cross-service coordination.
- **failure-analysis:** Essential for multi-step migrations.
- **api-contracts:** For contract versioning and sunset policies.

## Checklist

### Pre-Migration
- [ ] All consumers of current contract identified
- [ ] New contract fully specified (before/after diff)
- [ ] Backward compatibility window defined
- [ ] Consumer communication plan in place
- [ ] Migration tested in non-production environment

### Execution
- [ ] Same-change alignment: runtime, modules, tests, docs, contracts, commands, baselines
- [ ] Old and new paths coexist during transition (if needed)
- [ ] Feature flag or version negotiation controls rollout (if applicable)
- [ ] Monitoring confirms new path works before old is removed
- [ ] Rollback procedure tested

### Post-Migration
- [ ] Deprecated paths removed — no permanent dual contracts
- [ ] All docs reflect new path only
- [ ] Deprecation warnings removed from code
- [ ] Migration artifacts cleaned up

## Gotchas

- Deprecation warnings in logs that nobody reads are not deprecation. Add response headers (`Sunset`, `Deprecation`) *and* monitor usage metrics.
- "Same-change alignment" means runtime, tests, docs, and contracts must all update together. Updating the code but not the docs creates a migration that looks complete but isn't.
- Dual contracts intended as "temporary" become permanent without an enforced sunset date. Set the date when you create the new path, not later.

## Patterns

### Default: Expand-Contract
1. **Expand** — add new alongside old (additive, backward compatible)
2. **Migrate** — update consumers to new contract
3. **Verify** — confirm all migrated via logs/metrics
4. **Contract** — remove old after confirmation period

This is the safest approach. Use it unless you have a specific reason not to.

## Validation Loop

At each migration phase:
1. Check consumer usage metrics — are consumers actually moving to the new path?
2. Verify docs, tests, and contracts all reflect current state
3. If old path usage isn't declining, investigate before proceeding to removal

## Anti-Patterns

- **Big bang migration** — always have a transition period.
- **Permanent dual contracts** — set sunset date and enforce.
- **Migration without monitoring** — measure before removing old.
- **Forgetting docs** — update in same changeset.
