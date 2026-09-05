/**
 * Zeldoc.ai provider for the Pi coding agent.
 *
 * Registers `zeldoc` as an OpenAI-compatible provider and discovers the
 * models your API key can access through Pi's `refreshModels` hook. The
 * discovered catalog is persisted in Pi's models store, so the model you
 * used last time resolves at startup even before the network refresh runs.
 *
 * Authentication: set `ZELDOC_API_KEY` in your environment, or run `/login`
 * inside Pi, pick **Zeldoc.ai**, and paste the key.
 */

import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  FETCH_TIMEOUT_MS,
  ZELDOC_API_KEY_ENV,
  ZELDOC_BASE_URL,
  enrichModels,
  fetchZeldocModels,
  filterModelIds,
  loadModelsDevCatalog,
  seedModels,
  type ZeldocModel,
} from "../src/catalog.js";
import {
  ALLOWLIST_SETTING,
  readSettings,
  readZeldocAllowlist,
} from "../src/settings.js";

const PROVIDER_ID = "zeldoc";
const PROVIDER_NAME = "Zeldoc.ai";
const API: Api = "openai-completions";

/** Re-fetch the Zeldoc.ai catalog at most this often unless forced. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** Set this env var to any value to trace refreshes on stderr. */
const DEBUG_ENV = "PI_ZELDOC_PROVIDER_DEBUG";

function debug(message: string): void {
  if (process.env[DEBUG_ENV]) {
    process.stderr.write(`[pi-zeldoc-provider] ${message}\n`);
  }
}

/** Fields we persist for a model; everything else is derived on load. */
type StoredModel = Model<typeof API>;

/** Convert an enriched model into Pi's persisted `Model` shape. */
function toStoredModel(model: ZeldocModel): StoredModel {
  return {
    ...model,
    api: API,
    provider: PROVIDER_ID,
    baseUrl: ZELDOC_BASE_URL,
  };
}

/** Convert a persisted model back into the `registerProvider` model shape. */
function toProviderModel(model: Readonly<Model<Api>>): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/** Resolve the API key from Pi's credential store, then the environment. */
function resolveApiKey(context: RefreshModelsContext): string | undefined {
  const credential = context.credential;
  if (credential?.type === "api_key" && credential.key) return credential.key;
  const fromEnv = process.env[ZELDOC_API_KEY_ENV];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** True when the stored snapshot is recent enough to skip the network. */
function isFresh(context: RefreshModelsContext): boolean {
  const checkedAt = context.stored?.checkedAt;
  return (
    typeof checkedAt === "number" && Date.now() - checkedAt < CATALOG_TTL_MS
  );
}

/**
 * Combine the stored catalog with the built-in ZDev seeds so a model is
 * always resolvable, even before the first network refresh completes.
 * Stored entries win; seeds only fill in ids the store doesn't know yet.
 */
function withSeeds(
  models: ProviderModelConfig[],
  allowlist: string[] | undefined,
): ProviderModelConfig[] {
  const known = new Set(models.map((m) => m.id));
  const seeds = seedModels().filter(
    (m) => !known.has(m.id) && filterModelIds([m.id], allowlist).includes(m.id),
  );
  return [...models, ...seeds];
}

export default function (pi: ExtensionAPI): void {
  const allowlist = readZeldocAllowlist(readSettings());

  // Warnings raised before the UI exists are replayed on session start.
  let pendingWarning: string | undefined;
  let notify: ((message: string) => void) | undefined;
  const warn = (message: string): void => {
    if (notify) notify(message);
    else pendingWarning = message;
  };

  pi.on("session_start", async (_event, ctx) => {
    notify = (message) =>
      ctx.ui.notify(`${PROVIDER_NAME}: ${message}`, "warning");
    if (pendingWarning) {
      notify(pendingWarning);
      pendingWarning = undefined;
    }
  });

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: ZELDOC_BASE_URL,
    apiKey: `$${ZELDOC_API_KEY_ENV}`,
    api: API,

    // Synchronous seed: the ZDev models every Zeldoc.ai key can use. This
    // makes `--model zeldoc/zdev` resolve instantly; refreshModels replaces
    // the list with the full catalog once it has been fetched.
    models: withSeeds([], allowlist),

    async refreshModels(context) {
      const storedModels = context.stored?.models ?? [];
      const keptIds = new Set(
        filterModelIds(
          storedModels.map((m) => m.id),
          allowlist,
        ),
      );
      const cached = withSeeds(
        storedModels.filter((m) => keptIds.has(m.id)).map(toProviderModel),
        allowlist,
      );
      debug(
        `refresh: allowNetwork=${context.allowNetwork} force=${
          context.force === true
        } stored=${storedModels.length} fresh=${isFresh(context)}`,
      );

      if (!context.allowNetwork || (isFresh(context) && !context.force)) {
        return cached;
      }

      const apiKey = resolveApiKey(context);
      if (!apiKey) {
        if (cached.length === 0) {
          warn(
            `no API key — set ${ZELDOC_API_KEY_ENV} or run /login and ` +
              `pick ${PROVIDER_NAME}`,
          );
        }
        return cached;
      }

      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ]);

      try {
        const [zeldocModels, modelsDev] = await Promise.all([
          fetchZeldocModels(apiKey, signal),
          loadModelsDevCatalog(signal),
        ]);
        const ids = new Set(
          filterModelIds(
            zeldocModels.map((m) => m.id),
            allowlist,
          ),
        );
        const enriched = enrichModels(
          zeldocModels.filter((m) => ids.has(m.id)),
          modelsDev,
        );
        if (enriched.length === 0) {
          warn(
            allowlist
              ? `no models matched ${ALLOWLIST_SETTING}: ${allowlist.join(", ")}`
              : "the API returned no usable chat models",
          );
          return cached;
        }

        await context.publish({
          persist: {
            models: enriched.map(toStoredModel),
            checkedAt: Date.now(),
          },
        });
        debug(`refresh: fetched ${enriched.length} models`);
        return enriched;
      } catch (err: unknown) {
        if (context.signal.aborted) throw err;
        warn(
          `failed to load models — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return cached;
      }
    },
  });
}
