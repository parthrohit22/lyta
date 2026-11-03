# Runbook: model outage

A single model is failing, timing out, or returning unusable output, while
others still work.

## Symptoms

- `[lyta-operation]` lines with `outcome: "failure"` and `errorCode` of
  `unavailable`, `timeout` or `upstream` for one `model`.
- A rising share of `usedFallback: true` on successful calls.
- Users see "Instant is unavailable right now", "Deep Review timed out", or
  similar `degraded` messages.

## What LYTA already does

For each attempt, `callWithPolicy()` in `src/services/ai.ts` applies the
profile's policy from `src/ai/registry.ts`:

1. It tries the primary model `maxRetries + 1` times, each attempt bounded by
   `timeoutMs`.
2. It then tries the profile's fallback model once, but only if a
   capability-compatible fallback exists for this request.
3. If every attempt fails, the response carries the transparent `degraded`
   message.

| Profile | Primary | Fallback | Notes |
| --- | --- | --- | --- |
| Instant | Llama 4 Scout | Llama 3.1 8B | No fallback when the message has an image or exceeds ~8K tokens |
| Deep Review | Llama 4 Scout | Llama 3.1 8B | Same limits as Instant |
| Visual Review | Llama 4 Scout | none | No text-only model can stand in |
| Embedding (library indexing) | BGE Base | none | Another model's vectors would not match stored ones |

When the fallback model answers, the response metadata carries
`usedFallback: true` and the fallback's model id, so the change is visible.

## Steps

1. **Confirm scope.** Filter the tail by `model` and `errorCode`. If every
   model is failing, see [gateway-outage.md](gateway-outage.md) or
   [billing-limit.md](billing-limit.md) instead.
2. **Check upstream status.** Look for Workers AI incidents at
   <https://www.cloudflarestatus.com/>.
3. **If the fallback is coping**, leave the configuration alone. Fallback
   answers are lower depth but labelled. Record the incident window.
4. **If the outage is long and the primary keeps burning its retry budget on
   every request**, demote the model temporarily in `src/ai/registry.ts`.
   Either set its `availability` to `"disabled"`, or move it below the
   fallback in the affected profiles' `candidates`. Deploy through the normal
   PR path (`npm run check`, then the Deploy production workflow).
   - Disabling the only candidate for a profile (Visual Review or Embedding)
     makes that profile return `no_compatible_model`. That is intended: users
     are told it is unavailable rather than given a degraded substitute.
5. **If an embedding outage hits**, uploads and library search fail with
   "Embedding request failed." Do not point the embedding profile at a
   different model as a workaround. That needs the re-index procedure in
   [provider-change.md](provider-change.md).
6. **Recover.** Revert the registry change once upstream is healthy, and
   confirm `usedFallback` returns to its normal rate.

## Afterwards

Write up the window, the affected profiles, and the fallback rate from the
`[lyta-operation]` lines. If the fallback produced noticeably worse answers,
open an issue to re-run the evaluation suite against it (see
`eval/README.md`).
