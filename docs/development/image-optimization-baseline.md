# Image Optimization Baseline

## Reproduction

Run `node test/benchmark-images.js` from the repository root. The script generates deterministic
synthetic JPEG texture, EXIF-rotated JPEG, text PNG, translucent PNG and two-frame GIF fixtures.
No remote images or runtime configuration are read or modified. Fixture generation requires Sharp.

Each fixture/mode pair runs sequentially 12 times. Settings intentionally exercise encoding:
`maxLongSidePx=320`, `quality=0.8`, `minBytes=1`, `minSavingsRatio=0.1`.
These are benchmark settings, not production defaults. Duration covers protocol preparation, but
excludes fixture creation and construction of the initial data URL. CPU covers the full sample loop.

## Recorded Run

2026-09-07, Linux x64, Node 24.16.0, Sharp 0.35.4, Intel Xeon E5-2673 v4 2.30GHz.
Values are illustrative local measurements, not CI timing assertions or capacity guarantees.

| Fixture | Mode | Input Bytes | Output Bytes | p50 ms | p95 ms | CPU ms / 12 Samples |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic JPEG | preserve | 373718 | 373718 | 0.37 | 2.08 | 12.70 |
| Synthetic JPEG | legacy | 373718 | 25887 | 47.36 | 51.98 | 588.08 |
| Synthetic JPEG | adaptive | 373718 | 26385 | 56.34 | 64.80 | 712.99 |
| Rotated JPEG | adaptive | 374406 | 26463 | 67.23 | 70.72 | 805.48 |
| Text PNG | legacy | 9259 | 3066 | 14.30 | 16.51 | 179.78 |
| Text PNG | adaptive | 9259 | 9259 | 0.03 | 0.05 | 0.57 |
| Alpha PNG | legacy | 268 | 336 | 3.49 | 4.19 | 39.23 |
| Alpha PNG | adaptive | 268 | 268 | 0.01 | 0.06 | 0.26 |
| Two-frame GIF | legacy | 115 | 321 | 2.91 | 3.60 | 36.48 |
| Two-frame GIF | adaptive | 115 | 115 | 0.01 | 0.05 | 0.26 |

Process RSS started at 87.12 MiB after fixture creation; process peak RSS was 120.32 MiB.
This includes all modes, fixtures, the JS heap and Sharp caches; it is not per-image memory usage.

Adaptive encoding is slightly more expensive for JPEG in this run, but it corrects orientation,
preserves a color profile, verifies savings, and avoids reencoding non-JPEG inputs. The byte reduction
also includes downscaling: it is not a claim about encoding alone or model token savings.

## Fidelity And Resource Contracts

- Text PNG, alpha PNG and animation are byte-identical in adaptive mode; no OCR or animation-frame
  approximation is required for those preserved fixtures.
- Optimized EXIF JPEG has the expected rotated dimensions, JPEG MIME and ICC profile; no crop or enlargement.
- Insufficient savings, decoder limits, malformed images and preparation timeout retain original bytes.
- Protocol integration tests freeze all nine directions in JSON and SSE, including native `detail`,
  correct upstream URL/auth, usage of the selected bytes, and downstream terminal evidence.
- Explicit count/aggregate-byte rejection makes no upstream request. Governance rejection starts no encoder.
- Queue tests cover capacity and cancellation without prematurely releasing active codec slots.
- Admin checks use intercepted fixture APIs: desktop 1440x1000 and mobile 390x844, English/Chinese,
  mode visibility, preserved zero-valued queue setting and the saved JSON payload. No runtime config was changed.

## Unmet Release Gates

Synthetic noise is not a photographic quality dataset. JPEG text screenshots can still lose detail;
use preserve mode for fidelity-sensitive tasks. Real photos, OCR accuracy, color-critical images,
high-resolution malformed inputs under sustained load, production RSS/concurrency, actual client
disconnect timing and real-upstream visual token behavior have not been benchmarked here.

Before enabling adaptive mode in production, run a representative consented image corpus through
preserve and adaptive modes, compare visual/OCR outcomes, then size pixel/concurrency/queue budgets
against the deployment's memory limit. Keep the feature disabled until those application-specific gates pass.