# API load test

- Run at: 2026-11-01T08:10:20.070Z
- Machine: 4 CPU cores (Intel(R) Xeon(R) Processor @ 2.80GHz), 16 GB; API, database and load generator on the same machine
- Load: 20 requests in flight for 20.1 s, 3 signed-in users, 13 routes
- Requests: 3,481 (173.5 per second), errors 0 (0.00%)
- Latency overall: p50 107.8 ms, p95 221.1 ms, p99 265.7 ms

| Route | Requests | p50 ms | p95 ms | p99 ms | Errors |
|---|---:|---:|---:|---:|---:|
| GET /employees | 268 | 106.7 | 137.3 | 148.5 | 0 |
| GET /approvals/inbox | 536 | 67.0 | 95.2 | 110.0 | 0 |
| GET /org/overview | 268 | 99.9 | 134.0 | 158.2 | 0 |
| GET /leave/requests | 535 | 102.2 | 130.4 | 156.6 | 0 |
| GET /attendance/team | 536 | 136.7 | 182.7 | 367.1 | 0 |
| GET /employees/me | 536 | 108.9 | 141.7 | 167.8 | 0 |
| GET /attendance/today | 268 | 226.4 | 282.0 | 325.4 | 0 |
| GET /leave/balances | 267 | 137.2 | 170.5 | 194.3 | 0 |
| GET /notifications | 267 | 60.3 | 79.5 | 91.7 | 0 |

**Result: passed** (thresholds: p95 under 300 ms, errors under 1.00%).
