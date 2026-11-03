# Runbook: billing or usage limit reached

Model calls fail because the account's Workers AI allocation, or an external
provider's budget, is exhausted.

## Symptoms

- `[lyta-operation]` failures with `errorCode: "billing_limit"`.
  `normalizeModelError()` maps HTTP 402 and provider messages mentioning
  neurons, billing, quota, credit, allocation or spend limits to this code.
- Users see "<Profile> has reached its usage limit for now. Please retry later."

## What LYTA already does

- A `billing_limit` failure is **not retried and does not fall back**
  (`STOP_RETRYING` in `src/services/ai.ts`). Every Workers AI model draws on
  the same account allocation, so another attempt would fail the same way and
  add latency.
- Embeddings fail too, so uploads and library search fail until the limit
  resets.

## Steps

1. **Confirm the source.** In the Cloudflare dashboard, open AI → Workers AI
   and check usage against the plan. On the free plan Workers AI has a daily
   neuron allocation, and calls fail until it resets. If a gateway is
   configured, its Analytics page shows which profile and route drove the
   spend.
2. **Find the driver.** Group recent `[lyta-operation]` lines by `profile`,
   `route` and `workspace`, and sum `estimatedCostUsd` (a planning estimate
   from the registry, not a bill). A single workspace tag dominating usually
   means abuse or a runaway client. The per-identity rate limiter in
   `src/utils/rateLimit.ts` is the first lever there.
3. **Short term:** wait for the allocation to reset, or raise the budget or
   plan if the usage is legitimate. Do not swap the profiles to a cheaper
   model as an emergency measure without going through
   [provider-change.md](provider-change.md); that silently changes answer
   quality.
4. **If an external provider is ever enabled** and its budget runs out, set
   that registry entry's `availability` to `"disabled"` (or unset
   `AI_EXTERNAL_PROVIDERS`). Profiles then fall back to their Workers AI
   candidates, labelled with `usedFallback: true`.

## Afterwards

Compare actual spend against each profile's `targets.estimatedCostPerRequestUsd`
in `src/ai/registry.ts`, and update the targets if they were wrong.
