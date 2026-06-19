---
name: data-migration
description: >
  Plan database schema changes, data format changes, storage restructuring, and
  backfill strategies. Activate for Tier 3 changes involving schema changes, data
  transformations, or storage migrations that require rollback-for-data planning.
---

# Data Migration

## Related Skills
- **failure-analysis:** Essential for intermediate state safety.
- **production-readiness:** Required for migration monitoring and infrastructure changes.

## Checklist

### Planning
- [ ] Current and new schema documented (before/after diff)
- [ ] Volume assessed (data size, migration duration estimate)
- [ ] Migration script written and version-controlled
- [ ] Dry run executed in non-production environment
- [ ] Rollback-for-data plan defined (not just rollback-for-code)
- [ ] Backfill strategy defined for existing records

### Execution
- [ ] Backup taken before migration
- [ ] Migration runs idempotently (safe to re-run)
- [ ] Progress tracking in place
- [ ] Data validation after migration (row counts, checksums, spot checks)
- [ ] Application compatible with both schemas during migration window
- [ ] Zero or minimal downtime (online migration preferred)

### Post-Migration
- [ ] Data integrity verified (no orphans, corruption, missing records)
- [ ] Old schema artifacts cleaned up
- [ ] Compatibility shims removed from code
- [ ] Monitoring confirms normal operation

## Gotchas

- `DROP COLUMN` in the same deploy as the code change means rollback restores code that references a column that no longer exists. Always separate schema removal from code changes by at least one deploy cycle.
- A migration that takes 5 seconds on 1,000 rows may take 8 hours on 10M rows. Estimate from production volume, not dev. Plan for 10x longer than estimated.
- `BEGIN; ... millions of rows ... COMMIT;` holds locks for the entire duration. Batch in chunks of 1,000–10,000 rows with commits between.
- A migration without a checkpoint restarts from scratch on every interruption. Track last processed ID.

## Patterns

### Default: Expand-Contract (zero downtime)
1. **Expand:** Add new columns/tables alongside old. Write to both.
2. **Backfill:** Migrate existing data old → new.
3. **Validate:** Checksums, counts confirm match.
4. **Switch:** Read from new, stop writing to old.
5. **Contract:** Remove old after confirmation period.

### Resilience
- Upserts instead of blind inserts (idempotent)
- Track progress via checkpoint (last processed ID)
- On resume, skip completed work and validate checkpoint integrity
- Fail fast on invalid or empty input scope

## Plan-Validate-Execute

1. **Plan:** Write migration script. Document before/after schema diff and rollback-for-data strategy.
2. **Validate:** Dry-run on non-production with production-sized data:
   ```bash
   python scripts/migrate_data.py --dry-run --limit 100
   ```
3. **Execute:** Take backup. Run migration. Verify:
   ```bash
   psql -c "SELECT COUNT(*) FROM old_table;"
   psql -c "SELECT COUNT(*) FROM new_table;"
   # Counts must match. Spot-check sample rows.
   ```
4. **If counts don't match or spot-checks fail:** Stop. Do not proceed to contract phase. Investigate.

## Anti-Patterns

- **No dry run** — 10 rows local ≠ 10M rows production.
- **No data validation** — always verify counts and checksums.
- **Rollback ignoring data** — code rollback is easy; data rollback requires a separate reverse migration script.
