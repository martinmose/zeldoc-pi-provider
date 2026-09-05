/**
 * Zeldoc.ai model catalog enrichment.
 *
 * Zeldoc.ai's `/v1/models` endpoint returns model ids with optional
 * `max_input_tokens` / `max_output_tokens`, but no reasoning metadata.
 * This module enriches that list with thinking-level information from
 * models.dev (https://models.dev), which publishes a JSON catalog of
 * model capabilities including per-model reasoning effort levels.
 *
 * The models.dev catalog is large (~3.8MB) so it is cached locally with
 * a 7-day TTL. On a cache miss or expiry, it is re-fetched; on failure,
 * models are registered with Zeldoc.ai-only data and `reasoning: false`.
 *
 * ZDev models are Zeldoc.ai-native and have no models.dev entry, so their
 * thinking levels and limits are pinned in `ZELDOC_NATIVE_OVERRIDES`.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Zeldoc.ai API base URL. */
export const ZELDOC_BASE_URL = "https://api.zeldoc.ai/v1";

/** Environment variable holding the Zeldoc.ai API key. */
export const ZELDOC_API_KEY_ENV = "ZELDOC_API_KEY";

/** models.dev combined provider+model catalog (JSON). */
const MODELS_DEV_URL = "https://models.dev/catalog.json";

/** Local cache path for the models.dev catalog. */
const CACHE_DIR = join(homedir(), ".pi", "agent", "cache");
const CACHE_FILE = join(CACHE_DIR, "zeldoc-pi-provider-models-dev.json");

/** Cache TTL: 7 days in milliseconds. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Network and response-size limits. */
export const FETCH_TIMEOUT_MS = 15_000;
const MAX_ZELDOC_RESPONSE_BYTES = 1_000_000;
const MAX_MODELS_DEV_RESPONSE_BYTES = 10_000_000;

/** Fallback limits when neither Zeldoc nor models.dev reports them. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Substrings that identify non-chat models in the Zeldoc.ai catalog.
 * Used by the auto-filter default (when `zeldoc.models` is not set) to
 * exclude image-generation, audio/transcription, realtime, and embedding
 * models, which are not usable as the primary agent model.
 */
const NON_CHAT_PATTERNS = [
  "image",
  "whisper",
  "transcribe",
  "realtime",
  "translate",
  "embedding",
] as const;

/**
 * Provider ids preferred when flattening models.dev. The catalog stores
 * reasoning effort levels under `providers[id].models[mid]`, and many
 * routers mirror the same model with different effort sets. Official
 * labs are checked first so their effort values win.
 */
const PREFERRED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "zhipuai",
  "alibaba",
  "meta",
  "deepseek",
  "xai",
  "amazon",
  "microsoft",
  "nvidia",
  "cohere",
  "moonshotai",
] as const;

/** Pi thinking levels, in cycle order. */
const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** A model entry from Zeldoc.ai's `/v1/models` endpoint. */
export interface ZeldocApiModel {
  id: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

/** A provider-level model entry from models.dev (carries reasoning_options). */
interface ModelsDevProviderModel {
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values: string[] }>;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

/** A flattened models.dev entry, keyed by normalized model id. */
interface FlattenedEntry {
  reasoning: boolean;
  efforts: string[];
  limit: { context?: number; output?: number };
  inputModalities?: string[];
}

/** Cached flattened models.dev index. */
interface ModelsDevCache {
  fetchedAt: number;
  entries: Record<string, FlattenedEntry>;
}

interface LoadedCache {
  fetchedAt: number;
  index: Map<string, FlattenedEntry>;
}

/** A fully enriched Zeldoc.ai model, ready for `pi.registerProvider`. */
export interface ZeldocModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

/** Pinned capabilities for a Zeldoc.ai-native model. */
type NativeOverride = Pick<
  ZeldocModel,
  "reasoning" | "thinkingLevelMap" | "contextWindow" | "maxTokens" | "input"
>;

const ZDEV_LIMITS = {
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  input: ["text", "image"] as ("text" | "image")[],
};

/**
 * Static overrides for Zeldoc.ai-native models that have no models.dev entry.
 *
 * Limits and thinking levels mirror Zeldoc.ai's own OpenCode provider config
 * (https://docs.zeldoc.ai/connect-opencode). The `/v1/models` entries for
 * these models report no token limits, so they are pinned here.
 */
const ZELDOC_NATIVE_OVERRIDES: Record<string, NativeOverride> = {
  zdev: {
    ...ZDEV_LIMITS,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
  },
  "zdev-2": {
    ...ZDEV_LIMITS,
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
  },
};

/**
 * Models registered synchronously before the catalog has been fetched.
 * Every Zeldoc.ai key can use the ZDev models, so they are safe to seed.
 */
export function seedModels(): ZeldocModel[] {
  return Object.entries(ZELDOC_NATIVE_OVERRIDES).map(([id, override]) => ({
    id,
    name: id,
    reasoning: override.reasoning,
    ...(override.thinkingLevelMap
      ? { thinkingLevelMap: override.thinkingLevelMap }
      : {}),
    input: [...override.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: override.contextWindow,
    maxTokens: override.maxTokens,
  }));
}

/**
 * Resolve the native override for a model id. Exact matches win; any other
 * `zdev*` id (a future ZDev release) inherits the newest known ZDev profile
 * so it gets sensible limits before this package is updated.
 */
export function nativeOverride(id: string): NativeOverride | undefined {
  return (
    ZELDOC_NATIVE_OVERRIDES[id] ??
    (id.startsWith("zdev") ? ZELDOC_NATIVE_OVERRIDES["zdev-2"] : undefined)
  );
}

/**
 * Filter Zeldoc.ai model ids.
 *
 * If an allowlist is provided, keep only ids containing one of the
 * substrings (case-sensitive). Otherwise, auto-exclude non-chat models
 * (image/audio/embedding/realtime) by id substring.
 */
export function filterModelIds(
  ids: string[],
  allowlist: string[] | undefined,
): string[] {
  if (allowlist) {
    return ids.filter((id) => allowlist.some((p) => id.includes(p)));
  }
  return ids.filter(
    (id) => !NON_CHAT_PATTERNS.some((p) => id.toLowerCase().includes(p)),
  );
}

/** Parse a JSON response while enforcing an uncompressed size limit. */
async function readJsonResponse(
  res: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`response too large (${contentLength} bytes)`);
  }
  if (!res.body) throw new Error("response body is empty");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large (more than ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Fetch and validate the Zeldoc.ai model list. Throws on failure. */
export async function fetchZeldocModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<ZeldocApiModel[]> {
  const res = await fetch(`${ZELDOC_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const json = await readJsonResponse(res, MAX_ZELDOC_RESPONSE_BYTES);
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): ZeldocApiModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || value.id.trim().length === 0) {
      return [];
    }
    return [
      {
        id: value.id.trim(),
        ...(isPositiveSafeInteger(value.max_input_tokens)
          ? { max_input_tokens: value.max_input_tokens }
          : {}),
        ...(isPositiveSafeInteger(value.max_output_tokens)
          ? { max_output_tokens: value.max_output_tokens }
          : {}),
      },
    ];
  });
}

/** Validate and deserialize a flattened cache entry. */
function parseFlattenedEntry(value: unknown): FlattenedEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.reasoning !== "boolean" || !Array.isArray(entry.efforts)) {
    return null;
  }
  const efforts = entry.efforts.filter(
    (effort): effort is string => typeof effort === "string",
  );
  const limitValue = entry.limit;
  const limitRecord =
    limitValue && typeof limitValue === "object"
      ? (limitValue as Record<string, unknown>)
      : {};
  const inputModalities = Array.isArray(entry.inputModalities)
    ? entry.inputModalities.filter(
        (modality): modality is string => typeof modality === "string",
      )
    : undefined;
  return {
    reasoning: entry.reasoning,
    efforts,
    limit: {
      ...(isPositiveSafeInteger(limitRecord.context)
        ? { context: limitRecord.context }
        : {}),
      ...(isPositiveSafeInteger(limitRecord.output)
        ? { output: limitRecord.output }
        : {}),
    },
    ...(inputModalities ? { inputModalities } : {}),
  };
}

/** Load the cached models.dev index, including stale data for fallback. */
async function loadCache(): Promise<LoadedCache | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    if (Buffer.byteLength(raw, "utf-8") > MAX_MODELS_DEV_RESPONSE_BYTES) {
      return null;
    }
    const parsed = JSON.parse(raw) as ModelsDevCache;
    if (
      !parsed ||
      !Number.isFinite(parsed.fetchedAt) ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return null;
    }
    const index = new Map<string, FlattenedEntry>();
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = parseFlattenedEntry(value);
      if (key.length > 0 && entry) index.set(key, entry);
    }
    return index.size > 0 ? { fetchedAt: parsed.fetchedAt, index } : null;
  } catch {
    return null;
  }
}

/** Persist the flattened models.dev index atomically. */
async function saveCache(index: Map<string, FlattenedEntry>): Promise<void> {
  const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const cache: ModelsDevCache = {
      fetchedAt: Date.now(),
      entries: Object.fromEntries(index),
    };
    await writeFile(tempFile, JSON.stringify(cache), {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tempFile, CACHE_FILE);
  } catch {
    await unlink(tempFile).catch(() => {});
    // Cache is best-effort; failures are non-fatal.
  }
}

/** Normalize a model id for fuzzy matching (strip dots/dashes, lowercase). */
function normalizeId(id: string): string {
  const slash = id.lastIndexOf("/");
  const stripped = slash >= 0 ? id.slice(slash + 1) : id;
  if (stripped.length === 0) return "";
  return stripped.replace(/[-.]/g, "").toLowerCase();
}

/**
 * Flatten models.dev providers into a normalized-id → entry index.
 *
 * Reasoning effort levels live under `providers[id].models[mid]`. Many
 * routers mirror the same model with different effort sets, so official
 * labs (see PREFERRED_PROVIDERS) are checked first; the first provider
 * that exposes reasoning metadata for a model wins, and is not replaced.
 */
function flattenProviders(
  providers: Record<
    string,
    { models?: Record<string, ModelsDevProviderModel> }
  >,
): Map<string, FlattenedEntry> {
  const index = new Map<string, FlattenedEntry>();

  const ingest = (mid: string, value: unknown) => {
    const key = normalizeId(mid);
    if (
      key.length === 0 ||
      index.has(key) ||
      !value ||
      typeof value !== "object"
    ) {
      return;
    }
    const model = value as ModelsDevProviderModel;
    const options = Array.isArray(model.reasoning_options)
      ? model.reasoning_options
      : [];
    const efforts: string[] = [];
    for (const option of options) {
      if (
        option &&
        typeof option === "object" &&
        option.type === "effort" &&
        Array.isArray(option.values)
      ) {
        efforts.push(
          ...option.values.filter((item) => typeof item === "string"),
        );
      }
    }
    const context = model.limit?.context;
    const output = model.limit?.output;
    index.set(key, {
      reasoning: model.reasoning === true,
      efforts,
      limit: {
        ...(isPositiveSafeInteger(context) ? { context } : {}),
        ...(isPositiveSafeInteger(output) ? { output } : {}),
      },
      inputModalities: Array.isArray(model.modalities?.input)
        ? model.modalities.input.filter((item) => typeof item === "string")
        : undefined,
    });
  };

  // Official labs first, so their effort values take precedence.
  for (const pid of PREFERRED_PROVIDERS) {
    const provider = providers[pid];
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const [mid, model] of Object.entries(models)) ingest(mid, model);
  }
  // Remaining providers fill gaps for models the labs do not expose.
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const [mid, model] of Object.entries(models)) ingest(mid, model);
  }
  return index;
}

/**
 * Fetch the models.dev catalog, using a fresh local cache when available.
 * Returns a flattened index keyed by normalized model id, or null if the
 * catalog cannot be loaded (cache miss + fetch failure).
 */
export async function loadModelsDevCatalog(
  signal?: AbortSignal,
): Promise<Map<string, FlattenedEntry> | null> {
  const cached = await loadCache();
  const cacheAge = cached ? Date.now() - cached.fetchedAt : undefined;
  if (
    cached &&
    cacheAge !== undefined &&
    cacheAge >= 0 &&
    cacheAge <= CACHE_TTL_MS
  ) {
    return cached.index;
  }
  try {
    const res = await fetch(MODELS_DEV_URL, { signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await readJsonResponse(res, MAX_MODELS_DEV_RESPONSE_BYTES);
    if (!json || typeof json !== "object") return cached?.index ?? null;
    const providers = (json as { providers?: unknown }).providers;
    if (!providers || typeof providers !== "object") {
      return cached?.index ?? null;
    }
    const index = flattenProviders(
      providers as Record<
        string,
        { models?: Record<string, ModelsDevProviderModel> }
      >,
    );
    if (index.size === 0) return cached?.index ?? null;
    await saveCache(index);
    return index;
  } catch {
    return cached?.index ?? null;
  }
}

/**
 * Build a pi `thinkingLevelMap` from models.dev effort values.
 *
 * models.dev uses `none` for "thinking off"; pi uses `off`. Unsupported
 * pi levels map to `null` (hidden from the cycle). The map values are
 * the effort strings sent to the provider as `reasoning_effort`.
 */
export function buildThinkingLevelMap(efforts: string[]): ThinkingLevelMap {
  const set = new Set(efforts);
  const map: ThinkingLevelMap = {};
  map.off = set.has("none") ? "none" : set.has("off") ? "off" : null;
  for (const level of PI_LEVELS) {
    map[level] = set.has(level) ? level : null;
  }
  return map;
}

/**
 * Enrich Zeldoc.ai models with models.dev metadata.
 *
 * Priority for each field: native override > Zeldoc.ai API > models.dev > default.
 * Models with no reasoning metadata get `reasoning: false`.
 */
export function enrichModels(
  zeldocModels: ZeldocApiModel[],
  modelsDev: Map<string, FlattenedEntry> | null,
): ZeldocModel[] {
  return zeldocModels.map((zm): ZeldocModel => {
    const override = nativeOverride(zm.id);
    const md = modelsDev?.get(normalizeId(zm.id));
    const efforts = md?.efforts ?? [];

    const reasoning = override?.reasoning ?? md?.reasoning === true;

    const thinkingLevelMap: ThinkingLevelMap | undefined =
      override?.thinkingLevelMap ??
      (reasoning && efforts.length > 0
        ? buildThinkingLevelMap(efforts)
        : undefined);

    const contextWindow =
      zm.max_input_tokens ??
      override?.contextWindow ??
      md?.limit.context ??
      DEFAULT_CONTEXT_WINDOW;
    const maxTokens =
      zm.max_output_tokens ??
      override?.maxTokens ??
      md?.limit.output ??
      DEFAULT_MAX_TOKENS;

    const hasImageInput =
      override?.input.includes("image") ??
      md?.inputModalities?.includes("image") ??
      false;

    return {
      id: zm.id,
      name: zm.id,
      reasoning,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      input: hasImageInput ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
  });
}
