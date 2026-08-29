# M4.7 Performance, Memory, and Soak Validation

**Status: BLOCKED — real-device evidence has not been recorded.**

The repository contains a validator for an externally recorded Chrome/WebGPU run. It deliberately does not synthesize measurements. Run:

```bash
npm run test:m4-soak -- path/to/real-device-result.json
```

The evidence must identify the platform, browser, pinned runtime and model, use schema version 1 with `evidenceType: "real-device"`, cover at least 30 minutes and five reload cycles, and report the raw metrics below.

| Gate | Required result | Current evidence |
|---|---:|---|
| First-word latency p95 | <= 2,000 ms | Missing |
| Complete-result latency p95 | <= 5,000 ms | Missing |
| Main-thread tasks attributable to inference | 0 over 200 ms | Missing |
| Model re-downloads | 0 across >= 5 reloads | Missing |
| Post-warmup memory growth | < 10% over >= 30 minutes | Missing |
| Parsed-output rate | >= 95% | Missing |

`src/tests/test_m4_performance_soak.ts` exercises parsing, scheduling, and the fake runtime as a deterministic regression suite. It is not hardware performance evidence and cannot close M4.7.
