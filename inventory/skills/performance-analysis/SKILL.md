---
name: performance-analysis
description: >
  Identify performance bottlenecks and plan optimization strategies. Activate for
  Tier 2/3 changes affecting latency, throughput, resource usage, or scaling.
---

# Performance Analysis

## Related Skills
- **production-readiness:** Baseline metrics, monitoring, and alerting.
- **testing-strategy:** Performance regression tests.

## Checklist

- [ ] Baseline metrics captured (latency, throughput, resource usage)
- [ ] Bottleneck identified (CPU, memory, I/O, network, database)
- [ ] Optimization target defined (e.g., "reduce P95 latency by 50%")
- [ ] Profiling data collected (CPU profiles, memory dumps, trace logs)
- [ ] Change impact measured (before/after comparison)
- [ ] Regression tests for performance added
- [ ] Monitoring alerts for performance degradation configured

## Gotchas

- Local benchmarks rarely reflect production — connection pooling, cache hit rates, and concurrent load all change behavior. Profile with production-like data and concurrency.
- Adding an index speeds up reads but slows writes. On high-write tables, measure both.
- Caching a response that varies by user/tenant without including the variant in the cache key serves other users' data. Always key on what varies.
- P50 latency can look fine while P99 is catastrophic. Always measure tail latency.

## Patterns

### Default approach: Profile before optimizing
1. Capture baseline metrics (latency, throughput, resource usage)
2. Profile to identify the actual bottleneck — don't guess
3. Fix the #1 bottleneck only
4. Re-measure. If target met, stop. If not, profile again.

## Validation Loop

After each optimization:
1. Re-run the same benchmark/profile that identified the bottleneck
2. Compare before/after numbers. If improvement < 10%, reconsider the approach.
3. Run the full test suite — performance fixes often change behavior.
4. Check that no other metric regressed (e.g., memory went up to reduce latency).

## Anti-Patterns

- **Optimizing without profiling** — guesswork wastes time.
- **Fixing multiple things at once** — you won't know which change helped.
- **No baseline** — can't measure improvement.
