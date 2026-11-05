# Workflow load test

- Run at: 2026-11-02T10:49:11.669Z
- Machine: 4 CPU cores (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GB; API, database and load generator on the same machine

## Scale

- Hired 200 people through the API in 4.9 s (10 at a time), and gave each a salary in 1.1 s.
- Computed payroll for 2026-11: 216 payslips in 5.0 s (one request, one transaction). The run was then cancelled.

## Mixed workflows

- 12 workflows in flight for 60.2 s: 3,385 workflows, 10,343 requests (171.9 per second), errors 0 (0.00%)

| Workflow | Completed | Failed | p50 ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|
| punch | 1452 | 0 | 210.0 | 277.2 | 312.2 |
| leave | 483 | 0 | 308.3 | 403.8 | 470.4 |
| helpdesk | 483 | 0 | 278.3 | 351.6 | 376.3 |
| reads | 967 | 0 | 125.8 | 162.8 | 184.3 |

| Step | Requests | p50 ms | p95 ms | p99 ms | Errors |
|---|---:|---:|---:|---:|---:|
| reads | 4483 | 50.1 | 102.6 | 119.8 | 0 |
| hire (POST /employees) | 200 | 197.2 | 492.8 | 757.1 | 0 |
| assign salary (POST /payroll/salaries/:id) | 200 | 52.9 | 71.6 | 88.5 | 0 |
| start payroll run | 1 | 14.3 | 14.3 | 14.3 | 0 |
| compute payroll run | 1 | 4963.9 | 4963.9 | 4963.9 | 0 |
| cancel payroll run | 1 | 15.9 | 15.9 | 15.9 | 0 |
| punch (POST /attendance/punch) | 1452 | 124.0 | 182.0 | 212.3 | 0 |
| apply for leave (POST /leave/requests) | 483 | 112.8 | 169.8 | 204.4 | 0 |
| raise case (POST /helpdesk/cases) | 483 | 81.1 | 135.8 | 157.0 | 0 |
| reply (POST /helpdesk/cases/:id/messages) | 483 | 62.3 | 85.8 | 94.7 | 0 |
| approvals inbox (GET /approvals/inbox) | 624 | 31.3 | 47.3 | 54.3 | 0 |
| resolve (POST /helpdesk/cases/:id/status) | 483 | 66.0 | 92.6 | 109.4 | 0 |
| approve (POST /approvals/:id/approve) | 483 | 78.5 | 127.4 | 144.9 | 0 |
| confirm (POST /helpdesk/cases/:id/status) | 483 | 63.8 | 87.3 | 101.6 | 0 |
| cancel leave (POST /leave/requests/:id/cancel) | 483 | 66.5 | 121.7 | 158.1 | 0 |

**Result: passed** (thresholds: every step's p95 under 1000 ms, payroll under 60 s, errors under 1.00%).
