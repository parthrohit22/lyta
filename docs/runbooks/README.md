# Model operations runbooks

These runbooks cover LYTA's model layer: the provider and capability registry
(`src/ai/registry.ts`), the adapters (`src/ai/providers/`), and the optional
Cloudflare AI Gateway path (`src/ai/gateway.ts`).

| Situation | Runbook |
| --- | --- |
| One model is failing or slow | [model-outage.md](model-outage.md) |
| AI Gateway is failing or misconfigured | [gateway-outage.md](gateway-outage.md) |
| Workers AI allocation or a provider budget is exhausted | [billing-limit.md](billing-limit.md) |
| Adding, swapping, or retiring a model or provider | [provider-change.md](provider-change.md) |

## Where to look first

Every model call writes one content-free `[lyta-operation]` log line:

```json
{"route":"ai.chat","outcome":"failure","durationMs":812,"requestCount":1,"estimatedSpendUnits":1,
 "model":"@cf/meta/llama-4-scout-17b-16e-instruct","modelVersion":"llama-4-scout-17b-16e-instruct",
 "retryCount":1,"profile":"instant","provider":"workers-ai","workspace":"ws_3f9a0c12d4e1",
 "viaGateway":true,"errorCode":"unavailable"}
```

To stream these lines from production:

```bash
npx wrangler tail lyta --format json --search lyta-operation
```

Fields that matter during an incident:

- `errorCode` is one of `timeout`, `cancelled`, `rate_limited`,
  `billing_limit`, `unavailable`, `invalid_output`, `not_configured`,
  `no_compatible_model` or `upstream`.
- `usedFallback: true` means the profile's fallback model answered.
- `profile` and `workspace` attribute load and failures. `workspace` is a
  one-way hash tag, never the workspace key.
- `viaGateway` says whether the call went through AI Gateway.

When a gateway is configured, its dashboard (Cloudflare dashboard → AI → AI
Gateway → the gateway → Analytics) shows request, token, cost and error totals.
LYTA sends `collectLog: false` on every request, so the gateway does not store
prompt or response logs. Per-workspace and per-profile breakdowns come from the
`[lyta-operation]` lines.

## What users see

When a call fails after its retries and fallback, the chat response carries a
`degraded` object (`code`, `retryable`, `profile`, `message`). The message names
the profile and says what happened, for example "Deep Review has reached its
usage limit for now." LYTA never quietly answers with a model that lacks a
capability the profile requires, such as answering an image question with a
text-only model.

> **Verification status.** These procedures were written against the code and
> its tests. As of this writing no real AI Gateway has been created for LYTA,
> so the gateway steps have not been rehearsed against a live gateway.
