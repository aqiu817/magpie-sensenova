/**
 * Model discovery for SenseNova Token Plan.
 *
 * The Token Plan speaks the OpenAI dialect at `https://token.sensenova.cn/v1`,
 * and its `GET /models` endpoint does answer (401 without a key, not 404), so
 * the live list is the source of truth once an account exists.
 *
 * The built-in snapshot below is what keeps the provider selectable before the
 * first sign-in and when the fetch fails. Its model ids are the ones the
 * platform's own usage report actually emits — read from
 * `credit-usage-trend`'s `series[].model_id` — rather than the marketing names
 * in the announcement, which do not match what goes on the wire.
 *
 * @module magpie-sensenova/models
 */

/** The AI SDK package that speaks the OpenAI-compatible dialect. */
export const NPM = "@ai-sdk/openai-compatible";

/** Token Plan root. Every request path is appended to it. */
export const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";

/** Abandon a catalog fetch after this long so startup is never held open. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** How long a fetched list is trusted, in hours. */
export const DEFAULT_REFRESH_HOURS = 6;

/**
 * Output ceilings measured from the API, in tokens.
 *
 * The catalogue's `max_output_length` is **not** the enforced ceiling. Asking for
 * an impossible `max_tokens` makes the endpoint answer with its own valid range —
 * `field MaxTokens invalid, should be in [1, 393216]` — and the upper bounds below
 * are those answers. They matter: `deepseek-flash` accepts 384K while its catalogue
 * entry claims 64K, so trusting the catalogue understated it sixfold, and a user
 * asking exactly this question is why it was checked.
 *
 * The two DeepSeek entries differ by 3,216 tokens because that is what the endpoint
 * reports (384×1024 versus 384×1000); the asymmetry is theirs, not a typo here. A
 * model absent from this table falls back to the catalogue, which has been right
 * for every model whose two numbers were compared.
 */
export const MEASURED_OUTPUT_LIMITS = {
  "deepseek-flash": 393216,
  "deepseek-v4.1-flash": 393216,
  "deepseek-v4-flash": 384000,
  "glm-5.2": 131072,
  "sensenova-6.8-flash-lite": 65536,
};

/**
 * Fallbacks for a model the endpoint described without a context or output
 * ceiling. The endpoint does send both, so these should not be reached — they
 * exist so a malformed entry degrades instead of producing NaN.
 */
const DEFAULT_CONTEXT = 131072;
const DEFAULT_OUTPUT = 32768;

/**
 * The models to declare before any network call.
 *
 * Every number here is read off the platform's own `GET /v1/models` — it returns
 * `context_length`, `max_output_length`, `input_modalities`, `output_modalities`
 * and `supported_features` per model, so the snapshot mirrors that response
 * rather than guessing. Re-read it when the platform adds models; the previous
 * version of this table claimed 131072/32768 for all four, which was wrong by a
 * factor of 4 on `glm-5.2`'s output ceiling alone.
 */
export const FALLBACK_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: 262144,
    maxCompletionTokens: 65536,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    contextLength: 1048576,
    maxCompletionTokens: 393216,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    contextLength: 1048576,
    maxCompletionTokens: 131072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: 1048576,
    maxCompletionTokens: 65536,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
  },
];

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);
/** Only a real boolean counts; `reasoning` is sometimes an object instead. */
const bool = (v) => (typeof v === "boolean" ? v : undefined);

/**
 * Normalize one raw model entry from any of the shapes the endpoint may use.
 *
 * The response format is not fully documented, so both OpenAI's `{data:[…]}` and
 * a bare array are accepted, and capability fields are read under either the
 * snake_case or camelCase spelling. SenseNova's own names matter here: it reports
 * the output ceiling as **`max_output_length`** (not `max_completion_tokens`, not
 * `max_output_tokens`) and its capabilities as a **`supported_features`** list
 * containing `tools` / `json_mode` / `reasoning`. Missing either made every model
 * look like it had a 32768 output ceiling and supported everything, which is
 * exactly the kind of invented number a model card must not carry.
 *
 * @param {object} raw - one entry from the endpoint.
 * @returns {object|null} a normalized model, or null when it has no id.
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;
  const fallback = FALLBACK_MODELS.find((m) => m.id === id);
  const features = list(raw.supported_features ?? raw.supportedFeatures) ?? list(raw.features);
  const has = (name) => (features ? features.includes(name) : undefined);
  return {
    id,
    name: text(raw.name) ?? text(raw.model_name) ?? fallback?.name ?? id,
    contextLength:
      positive(raw.context_length ?? raw.contextLength ?? raw.max_context_tokens) ??
      fallback?.contextLength ??
      DEFAULT_CONTEXT,
    maxCompletionTokens:
      MEASURED_OUTPUT_LIMITS[id] ??
      positive(
        raw.max_output_length ??
          raw.max_completion_tokens ??
          raw.maxCompletionTokens ??
          raw.max_output_tokens
      ) ??
      fallback?.maxCompletionTokens ??
      DEFAULT_OUTPUT,
    inputModalities:
      list(raw.input_modalities ?? raw.inputModalities) ?? fallback?.inputModalities ?? ["text"],
    outputModalities:
      list(raw.output_modalities ?? raw.outputModalities) ?? fallback?.outputModalities ?? ["text"],
    supportsTools:
      raw.supports_tools ??
      raw.supportsTools ??
      raw.tool_call ??
      has("tools") ??
      fallback?.supportsTools ??
      true,
    reasoning:
      bool(raw.reasoning) ?? bool(raw.supports_reasoning) ?? has("reasoning") ?? fallback?.reasoning ?? true,
  };
}

/**
 * A chat-completions endpoint can only serve models that write text.
 *
 * `/v1/models` lists more than chat models. `sensenova-u1.5-lite` advertises
 * `output_modalities: ["image"]` — it draws infographics — and asking it for a
 * completion answers 404 `model is not found`, so offering it in a chat picker
 * only produces an error the user cannot explain. Its text-only sibling is listed
 * the same way, which is why the filter is on the output modality rather than on
 * the id.
 */
const writesText = (m) => (m.outputModalities ?? []).includes("text");

/** Pull a model array out of whatever envelope the endpoint used. */
export function extractModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows.map(normalizeModel).filter((m) => m !== null && writesText(m));
}

/**
 * A catalog that fetches once, caches, and never throws.
 *
 * @param {{baseURL?: string, timeoutMs?: number, refreshHours?: number, fetchImpl?: Function}} [opts]
 */
export function createCatalog(opts = {}) {
  const baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshMs = (opts.refreshHours ?? DEFAULT_REFRESH_HOURS) * 3600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  let cached = null;
  let fetchedAt = 0;
  let inflight = null;

  /** The last successful list, or null. Never blocks. */
  const peek = () => cached;

  /** Fetch the list, at most once per refresh window. */
  const load = async (apiKey) => {
    const fresh = cached && Date.now() - fetchedAt < refreshMs;
    if (fresh) return cached;
    if (inflight) return inflight;
    if (!apiKey) return cached ?? [];

    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const models = extractModels(await res.json());
        if (models.length) {
          cached = models;
          fetchedAt = Date.now();
        }
        return models.length ? models : cached ?? [];
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();

    return inflight;
  };

  return { peek, load, baseURL };
}

/* --------------------------------------------------------- Magpie 对象形状 */

function hasNonTextInput(m) {
  return (m.inputModalities ?? []).some((modality) => modality !== "text");
}

function modalityFlags(modalities) {
  const l = list(modalities) ?? ["text"];
  return {
    text: l.includes("text"),
    image: l.includes("image"),
    audio: l.includes("audio"),
    video: l.includes("video"),
    pdf: l.includes("pdf"),
  };
}

/** The `config` entry declaring one model. */
export function toConfigModel(m) {
  return {
    name: m.name,
    reasoning: m.reasoning === true,
    tool_call: m.supportsTools === true,
    attachment: hasNonTextInput(m),
    modalities: { input: m.inputModalities, output: m.outputModalities },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
  };
}

/** The `provider.models` entry for one model. */
export function toProviderModel(m, providerID, { baseURL = DEFAULT_BASE_URL, npm = NPM } = {}) {
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url: baseURL, npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: hasNonTextInput(m),
      toolcall: m.supportsTools === true,
      input: modalityFlags(m.inputModalities),
      output: modalityFlags(m.outputModalities),
      interleaved: false,
    },
    release_date: "",
    variants: {},
  };
}
