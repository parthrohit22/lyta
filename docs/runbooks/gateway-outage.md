# Runbook: AI Gateway outage or misconfiguration

Every model call fails at once while a gateway is configured, or calls fail
with `not_configured`.

## How the gateway is wired

- `AI_GATEWAY_ID` (Worker var) names the gateway. When it is set, every
  Workers AI call carries the binding's `gateway` option. That covers chat,
  streaming, structured output and embeddings, plus route-level
  `env.AI.run` calls, which the Worker entry wraps with `withModelGateway()`.
- `AI_GATEWAY_REQUIRED="true"` makes a missing or invalid `AI_GATEWAY_ID` a
  hard `not_configured` error instead of a silent direct call. Production
  should set this once its gateway exists.
- Each request sets `collectLog: false`, `skipCache: true`,
  `requestTimeoutMs` from the profile, `retries.maxAttempts: 1`, and four
  metadata fields (`profile`, `route`, `workspace`, `attempt`). Retries and
  fallback run in the Worker, not in the gateway.

## Symptoms

- All models fail together with `viaGateway: true` and `errorCode`
  `unavailable`, `upstream` or `rate_limited`.
- Or every call fails with `errorCode: "not_configured"`. That is a config
  problem, not an outage.
- Users see "<Profile> is unavailable right now" or "Model routing is
  misconfigured. An operator needs to fix it before this can run."

## Steps

### `not_configured`

1. Check the deployed vars in the Cloudflare dashboard (Workers & Pages →
   lyta → Settings → Variables). Look for `AI_GATEWAY_ID` and
   `AI_GATEWAY_REQUIRED`.
2. `AI_GATEWAY_ID` must be a gateway name made only of letters, digits, `-`
   and `_`, at most 64 characters, and that gateway must exist in the same
   account (Cloudflare dashboard → AI → AI Gateway).
3. Fix the var and redeploy. Do not clear `AI_GATEWAY_REQUIRED` to "make it
   work"; that hides the misconfiguration.

### Gateway returning errors

1. Check <https://www.cloudflarestatus.com/> for AI Gateway incidents, and the
   gateway's Analytics page for its error rate.
2. Check whether the gateway has rate limiting configured. A gateway
   rate limit shows up as `rate_limited` across every profile. Raise or
   remove the limit if it is the cause.
3. **Emergency bypass (direct path).** If the gateway itself is down and the
   outage is user-facing, the only bypass is to route around it:
   - Remove `AI_GATEWAY_ID` and set `AI_GATEWAY_REQUIRED` to `"false"`, then
     redeploy. Calls then go straight to Workers AI with no gateway option.
   - This suspends the "all production traffic through the gateway" policy.
     Record when it started and why. Gateway analytics and gateway rate limits
     stop applying, but LYTA's own `[lyta-operation]` attribution and its
     in-Worker rate limiter keep working.
   - External-provider models (if any are ever enabled) stop being selectable,
     because they only run behind a gateway. Profiles fall back to Workers AI
     candidates or return `no_compatible_model`.
4. **Restore.** Put `AI_GATEWAY_ID` and `AI_GATEWAY_REQUIRED="true"` back as
   soon as the gateway is healthy, redeploy, and confirm `viaGateway: true`
   in the tail.

## Not covered yet

- LYTA does not fail over between two gateways.
- The steps above have not been rehearsed against a real gateway. Rehearse
  them in a preview deployment before relying on them in production.
