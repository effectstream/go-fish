# ZK Proof Time

Min / average / max proof generation time per circuit, aggregated across the
benchmark runs in the referenced screenshots (WASM prover at 10, 14, and 16
threads; HTTP proof server at 9 threads; partial batcher-kachina run covering
k7–k13).

| K         | MIN      | AVE      | MAX       |
| --------- | -------- | -------- | --------- |
| test_k5   | 42 ms    | 291 ms   | 593 ms    |
| test_k6   | 35 ms    | 291 ms   | 551 ms    |
| test_k7   | 42 ms    | 557 ms   | 1.41 s    |
| test_k8   | 55 ms    | 696 ms   | 1.60 s    |
| test_k9   | 85 ms    | 878 ms   | 1.86 s    |
| test_k10  | 136 ms   | 1.27 s   | 2.51 s    |
| test_k11  | 226 ms   | 2.03 s   | 3.72 s    |
| test_k12  | 429 ms   | 3.44 s   | 6.03 s    |
| test_k13  | 1.04 s   | 8.07 s   | 14.05 s   |
| test_k14  | 2.05 s   | 13.19 s  | 26.41 s   |
| test_k15  | 4.06 s   | 25.71 s  | 51.27 s   |
| test_k16  | 7.72 s   | 47.41 s  | 94.45 s   |
| test_k17  | 14.81 s  | 90.82 s  | 181.02 s  |
