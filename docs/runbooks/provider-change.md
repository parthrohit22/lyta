# Runbook: adding, swapping, or retiring a model or provider

Changing which model serves a profile is a registry change plus an evaluation
result. No product workflow code should change. If a change needs edits
outside `src/ai/` (and the docs), stop and ask why.

## Adding or swapping a Workers AI chat model

1. **Evaluate first.** Run `eval/dataset.json` against the current model and
   the candidate, following `eval/README.md` ("Running against a real
   model"). Record the pass rate, latency, and estimated cost.
2. **Add a registry entry** to `MODEL_REGISTRY` in `src/ai/registry.ts`:
   - `capabilities`: text, vision, `structuredOutput`
     (`native`/`prompted`/`none`), tool calling, streaming, embeddings. Take
     these from the provider's model catalog. Don't claim one you haven't
     checked.
   - `limits.contextTokens` from the catalog, plus a `maxOutputTokens`
     ceiling at least as large as any profile's `max_tokens` that will use
     it.
   - `privacyClass`: `cloudflare-hosted` for Workers AI.
   - `availability: "enabled"`.
   - `cost`: billing source and a per-request planning estimate.
   - `evaluation`: `method: "manual-real-model"`, the dataset version, the
     `passRate`, the date, and a link to the PR that records the comparison.
     The pass rate must meet `eval/dataset.json`'s `baselinePassRate`, and
     `grandfathered-baseline` is not allowed for new entries.
3. **Place it** in the `candidates` list of each profile it should serve.
   The first compatible candidate is primary and the next compatible one is
   the fallback.
4. **Run `npm run check`.** `tests/unit/model-registry.test.ts` rejects
   entries with no evaluation, a below-baseline pass rate, unknown candidate
   ids, or a `max_tokens` larger than the model's ceiling. The provider
   contract suite (`tests/unit/model-provider-contract.test.ts`) already
   covers the Workers AI adapter, so a new Workers AI model needs no adapter
   change.
5. **Ship** through `RELEASE_CHECKLIST.md`, step 3 (AI-evaluation
   comparison). CI's "Report model/prompt configuration changes" step prints
   the registry diff for review.

## Changing the embedding model

Stored library vectors come from the current embedding model, and vectors
from a different model are not comparable. The embedding profile therefore
has no fallback. Swapping it requires a migration that re-embeds every stored
chunk, which does not exist yet. Do not change `PRODUCT_PROFILES.embedding`
until it does.

## Enabling the external-provider path (AI Gateway)

The adapter (`src/ai/providers/gatewayExternal.ts`) sends OpenAI-compatible
`chat/completions` requests through AI Gateway's universal endpoint. It has
only been tested against a mocked gateway. Before enabling it:

1. **Decide on data handling.** External models use the
   `external-processor` privacy class, which means user content leaves
   Cloudflare under the provider's terms. Get that decision written down,
   and update the affected profile's `dataHandling` text so the UI says it.
2. **Credentials.** Store the provider key in the gateway (BYOK) where
   possible, so no key ever enters the Worker. Otherwise use a Worker secret:

   ```bash
   npx wrangler secret put AI_EXTERNAL_PROVIDER_KEY
   ```

   Never put a key in `wrangler.jsonc`, the repository, browser code, or
   Durable Object storage. `tests/unit/ai-gateway.test.ts` checks the
   browser bundle, the Durable Object sources and `wrangler.jsonc`.
3. **Evaluate** the external model as in the Workers AI steps above, and
   record the result on its registry entry.
4. **Turn it on.** All of these are required, and each one alone is a no-op:
   - Set the registry entry to `availability: "enabled"`, with its evaluation
     recorded.
   - Add `"external-processor"` to the profile's `allowedPrivacyClasses`, and
     add the entry to that profile's `candidates`.
   - Configure a gateway (`AI_GATEWAY_ID`).
   - Set `AI_EXTERNAL_PROVIDERS="enabled"`.
5. **Run the contract suite** and a real request in a preview deployment
   before production. The streamed output is rewritten into LYTA's
   `{"response": …}` SSE format, so check that streamed replies render.

## Retiring a model

Set its `availability` to `"disabled"` first and deploy. Once no profile
lists it and no incident needs a rollback to it, remove the entry. Removing a
grandfathered entry (one of `GRANDFATHERED_MODEL_IDS`) also means removing it
from that set.
