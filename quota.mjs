/**
 * SenseNova 控制台「积分额度」客户端。
 *
 * 额度不在 LLM API 上，只在控制台自己的接口里：
 *
 *   GET https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage
 *   Authorization: Bearer <控制台 access_token>
 *
 * 而这个 token 既不是 API Key 也不是永久的：它是 OAuth2 令牌，约 2.4 小时过期。
 * 续期有三条路，按可靠性排序，与命令行工具 snquota 完全一致：
 *
 *   1. refresh_token（标准续期）
 *   2. 浏览器会话 cookie（重放授权码 + PKCE 流程）
 *   3. 账号密码（完整自动登录）
 *
 * 凭据从 `~/.sensenova-quota.json` 读（也可用环境变量 SENSENOVA_QUOTA_CONFIG
 * 指定），这份文件由 snquota 命令行写入。刻意与 Magpie 账号里存的 API Key
 * 分开：API Key 走 LLM 请求，控制台凭据只用来读额度，两者的生命周期和
 * 权限范围都不同，混在一个字段里迟早会互相覆盖。
 *
 * 这个文件被设计成可以直接单测：不读 Magpie、不读全局状态，只用参数。
 *
 * @module quota
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { fill, poolLabel, strings as tableFor } from "./i18n.mjs";

const DEFAULT_BASE = "https://platform.sensenova.cn";
const DEFAULT_CLIENT_ID = "nova";

/** 不同站点对应的 IAM 登录服务（抄自控制台前端配置）。 */
const IAM_BASE = {
  "platform.sensenova.cn": "https://iam.sensecoreapi.cn/iam/authn",
  "nova.sensecore.tech": "https://iam.sensecoreapi.tech/iam/authn",
};

/* ------------------------------------------------------------------ 工具 */

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) };
}

const randState = () => b64url(crypto.randomBytes(12));

/** 解析 JWT 载荷；不透明 token 返回 null。 */
export function parseJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload === "object" && payload ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 账号自己的名字，直接从控制台 token 里读。
 *
 * 两个 token 都带它：`access_token.ext.username`，以及 id_token 里那个嵌套的
 * `id_token.id_token.username`（后者还带 user_avatar / user_id / login_type）。
 * 实测两者取到的值相同。控制台头部显示的就是这个名字，所以它才是用户认得的
 * 那个标识 —— 而登录时填的账号可能是手机号或邮箱，是另一回事。
 *
 * 在这里读的好处是：**只填了 API Key、没填账号密码的情况下也能拿到名字**，
 * 于是账号行不必退化成显示 API Key 后缀。
 *
 * @param {object} cfg - 凭据（含 access_token / id_token）。
 * @returns {string|undefined}
 */
export function accountNameOf(cfg) {
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return (
    pick(parseJwt(cfg?.access_token)?.ext?.username) ??
    pick(parseJwt(cfg?.id_token)?.id_token?.username)
  );
}

/** 与控制台一致的数字格式：千分位 + 最多 6 位小数。 */
export function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "—");
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * 数量按 Magpie 自己的写法来：整数给整数，否则保留两位。
 *
 * 照抄自 @magpie-community/opencode-workbuddy-auth 的 `compact`，因为
 * `display` 和它并排渲染，格式不一致会显得突兀。
 */
export function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/* -------------------------------------------------------------- 凭据读写 */

export function configPath(env = process.env) {
  return env.SENSENOVA_QUOTA_CONFIG || path.join(os.homedir(), ".sensenova-quota.json");
}

export function readCredentials(file = configPath()) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function writeCredentials(cfg, file = configPath()) {
  try {
    // Internal bookkeeping keys are all `__`-prefixed, and none of them belong
    // in the file: the CLI reads it back, and flags like `__writable` are
    // per-call. Strip by prefix so a new one can never leak by being forgotten.
    const rest = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("__")));
    const next = { ...rest, saved_at: new Date().toISOString() };
    // The per-account slots live in the same file; writing the top-level record must
    // not erase them.
    const current = readCredentials(file) ?? {};
    if (isRecord(current[ACCOUNTS])) next[ACCOUNTS] = current[ACCOUNTS];
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows 上忽略 */
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------ 按账号分开的令牌 */

/**
 * One console token per account lives in the shared credentials file.
 *
 * The top-level fields belong to the single-account record the `snquota` CLI writes,
 * and this plugin leaves them alone. Its own tokens go under `accounts[<slot>]`,
 * because quota is account-level: one token belongs to one console account, and
 * holding them in a single top-level record represents only whichever account signed
 * in last — on screen, several rows showing one and the same figure.
 */
const ACCOUNTS = "accounts";

/** What one slot holds: a token and the material to renew it. */
export const SLOT_FIELDS = [
  "base",
  "client_id",
  "redirect_uri",
  "access_token",
  "refresh_token",
  "expires_at",
  "id_token",
  "cookie",
  "iam_base",
];

/**
 * The slot one account's credentials live in.
 *
 * A named account uses its name, because every API key on one account shares a single
 * console token — that is what "the quota is account-level" means. Without a name the
 * API key's fingerprint stands in: the slot has to be unique, or two rows read one
 * token and show one account's quota twice.
 *
 * @param {{name?: string, key?: string}} [input]
 * @returns {string|undefined}
 */
export function credentialSlotOf({ name, key } = {}) {
  const named = typeof name === "string" ? name.trim() : "";
  if (named) return named;
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return undefined;
  return `key:${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
}

/** The per-slot map, tolerating a file written before slots existed. */
const accountsOf = (file) => (isRecord(file?.[ACCOUNTS]) ? file[ACCOUNTS] : {});

/** Only the slot fields, so bookkeeping never reaches the file. */
const recordOf = (cfg) =>
  Object.fromEntries(SLOT_FIELDS.filter((f) => cfg?.[f] !== undefined).map((f) => [f, cfg[f]]));

/** The top-level single-account record, without the slot map and internal keys. */
const legacyOf = (file) =>
  Object.fromEntries(
    Object.entries(file ?? {}).filter(([k]) => k !== ACCOUNTS && !k.startsWith("__"))
  );

/**
 * One account's console credentials, or an empty object.
 *
 * The top-level record counts only when it really belongs to this account: a token
 * names the account it was issued to, so a mismatch means it is someone else's. A
 * token that yields no name at all — an old file, or an opaque one — is accepted as
 * this machine's only record, which is the shape every earlier version wrote.
 *
 * @param {object|null} file - `readCredentials`'s result.
 * @param {string|undefined} slot - `credentialSlotOf`'s result.
 * @returns {object}
 */
export function readAccountCredentials(file, slot) {
  if (!slot) return {};
  const own = accountsOf(file)[slot];
  if (isRecord(own)) return own;
  const legacy = legacyOf(file);
  if (!legacy.access_token && !legacy.refresh_token) return {};
  const named = accountNameOf(legacy);
  if (!named) return legacy;
  return named === slot ? legacy : {};
}

/** Whether those credentials came from the CLI's top-level record rather than a slot. */
export function isLegacyCredentials(file, slot) {
  if (!slot) return false;
  if (isRecord(accountsOf(file)[slot])) return false;
  const legacy = legacyOf(file);
  if (!legacy.access_token && !legacy.refresh_token) return false;
  const named = accountNameOf(legacy);
  return !named || named === slot;
}

/**
 * Write one account's credentials into its own slot, leaving the other slots and the
 * top-level record untouched.
 */
export function writeAccountCredentials(cfg, slot, file = configPath()) {
  if (!slot) return false;
  try {
    const current = readCredentials(file) ?? {};
    const accounts = { ...accountsOf(current) };
    accounts[slot] = {
      ...(isRecord(accounts[slot]) ? accounts[slot] : {}),
      ...recordOf(cfg),
      saved_at: new Date().toISOString(),
    };
    const next = { ...legacyOf(current), [ACCOUNTS]: accounts };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows 上忽略 */
    }
    return true;
  } catch {
    return false;
  }
}

/** token 是否已过期（留 60 秒余量）。非 JWT 且无 expires_at 时返回 false（无法判断就先试）。 */
export function isExpired(cfg, now = Date.now()) {
  const exp = Number(cfg?.expires_at) || Number(parseJwt(cfg?.access_token)?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  return now / 1000 > exp - 60;
}

/* ------------------------------------------------------------ cookie jar */

/** 跨 iam.sensecoreapi.cn 与 platform.sensenova.cn，所以按域+路径存。 */
class CookieJar {
  constructor(cookieString) {
    this.map = new Map();
    if (cookieString) {
      for (const part of String(cookieString).split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        const name = part.slice(0, i).trim();
        if (name) this.map.set(`${name}|*|/`, { name, value: part.slice(i + 1).trim(), domain: null, path: "/" });
      }
    }
  }

  absorb(url, res) {
    let list = [];
    try {
      list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    } catch {
      list = [];
    }
    if (!list.length) {
      const one = res.headers.get("set-cookie");
      if (one) list = [one];
    }
    const host = new URL(url).hostname;
    for (const raw of list) {
      const segs = String(raw).split(";");
      const eq = segs[0].indexOf("=");
      if (eq < 0) continue;
      const name = segs[0].slice(0, eq).trim();
      const value = segs[0].slice(eq + 1);
      let domain = null;
      let cookiePath = "/";
      for (const attr of segs.slice(1)) {
        const [k, v] = attr.split("=");
        const key = (k || "").trim().toLowerCase();
        if (key === "domain" && v) domain = v.trim().replace(/^\./, "").toLowerCase();
        else if (key === "path" && v) cookiePath = v.trim();
      }
      this.map.set(`${name}|${domain || host}|${cookiePath}`, {
        name,
        value,
        domain: domain || host,
        path: cookiePath,
      });
    }
  }

  header(url) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const out = [];
    for (const c of this.map.values()) {
      if (c.domain === null) {
        out.push(`${c.name}=${c.value}`);
        continue;
      }
      if ((host === c.domain || host.endsWith(`.${c.domain}`)) && u.pathname.startsWith(c.path)) {
        out.push(`${c.name}=${c.value}`);
      }
    }
    return out.join("; ");
  }
}

/* ------------------------------------------------------------------ 续期 */

async function postToken(cfg, form, fetchImpl) {
  const url = `${(cfg.base || DEFAULT_BASE).replace(/\/$/, "")}/oauth2/token`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { res, data, text };
}

function applyToken(cfg, data) {
  cfg.access_token = data.access_token;
  if (data.refresh_token) cfg.refresh_token = data.refresh_token;
  if (data.id_token) cfg.id_token = data.id_token;
  const exp = Number(data.expires_in);
  cfg.expires_at = Number.isFinite(exp) && exp > 0
    ? Math.floor(Date.now() / 1000) + exp
    : Number(parseJwt(data.access_token)?.exp) || undefined;
}

export class QuotaError extends Error {
  constructor(message, kind = "auth") {
    super(message);
    this.name = "QuotaError";
    this.kind = kind;
  }
}

async function refreshWithRefreshToken(cfg, fetchImpl, t) {
  const { res, data, text } = await postToken(
    cfg,
    {
      grant_type: "refresh_token",
      client_id: cfg.client_id || DEFAULT_CLIENT_ID,
      refresh_token: cfg.refresh_token,
    },
    fetchImpl
  );
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || text.slice(0, 200);
    throw new QuotaError(fill(t.refreshFailed, { detail }));
  }
  applyToken(cfg, data);
}

function buildAuthorize(cfg) {
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  const redirectUri = cfg.redirect_uri || base;
  const { verifier, challenge } = makePkce();
  const url = new URL(`${base}/oauth2/auth`);
  url.search = new URLSearchParams({
    client_id: cfg.client_id || DEFAULT_CLIENT_ID,
    response_type: "code",
    scope: "openid offline offline_access",
    redirect_uri: redirectUri,
    state: randState(),
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url, verifier, redirectUri };
}

async function exchangeCode(cfg, { code, verifier, redirectUri }, fetchImpl, t) {
  const { res, data, text } = await postToken(
    cfg,
    {
      grant_type: "authorization_code",
      client_id: cfg.client_id || DEFAULT_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    },
    fetchImpl
  );
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || text.slice(0, 200);
    throw new QuotaError(fill(t.exchangeFailed, { detail }));
  }
  applyToken(cfg, data);
}

async function hop(url, jar, fetchImpl, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const cookie = jar.header(url);
  if (cookie) headers.Cookie = cookie;
  const res = await fetchImpl(url, { ...opts, headers, redirect: "manual" });
  jar.absorb(url, res);
  return res;
}

const codeOf = (location) => {
  if (!location) return null;
  try {
    return new URL(location).searchParams.get("code");
  } catch {
    return null;
  }
};

async function renewWithCookie(cfg, fetchImpl, t) {
  const { url, verifier, redirectUri } = buildAuthorize(cfg);
  const jar = new CookieJar(cfg.cookie);
  const res = await hop(url, jar, fetchImpl, { headers: { Accept: "text/html" } });
  const location = res.headers.get("location") || "";
  if (/login_challenge=/.test(location)) {
    throw new QuotaError(t.cookieDead);
  }
  const code = codeOf(location);
  if (!code) {
    throw new QuotaError(fill(t.noAuthCode, { status: res.status }));
  }
  await exchangeCode(cfg, { code, verifier, redirectUri }, fetchImpl, t);
}

async function renewWithPassword(cfg, fetchImpl, t) {
  const { url, verifier, redirectUri } = buildAuthorize(cfg);
  const jar = new CookieJar(cfg.cookie);
  const iam =
    cfg.iam_base ||
    IAM_BASE[new URL(cfg.base || DEFAULT_BASE).hostname] ||
    "https://iam.sensecoreapi.cn/iam/authn";

  const res = await hop(url, jar, fetchImpl, { headers: { Accept: "text/html" } });
  const location = res.headers.get("location") || "";
  let code = codeOf(location);
  if (code) return exchangeCode(cfg, { code, verifier, redirectUri }, fetchImpl, t);

  const challenge = /login_challenge=([^&\s]+)/.exec(location)?.[1];
  if (!challenge) throw new QuotaError(fill(t.noChallenge, { status: res.status }));

  const checkRes = await hop(
    `${iam}/v1/auth/checkChallenge?challenge=${encodeURIComponent(challenge)}`,
    jar,
    fetchImpl,
    { headers: { Accept: "application/json" } }
  );
  const check = await checkRes.json().catch(() => null);
  if (!check?.is_valid) throw new QuotaError(t.challengeExpired);

  const loginRes = await hop(`${iam}/v1/auth/nova/login`, jar, fetchImpl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: (cfg.base || DEFAULT_BASE).replace(/\/$/, ""),
      Referer: `${(cfg.base || DEFAULT_BASE).replace(/\/$/, "")}/`,
    },
    body: JSON.stringify({
      username: cfg.username,
      password: cfg.password,
      challenge,
      is_encrypt: false,
    }),
  });
  const loginData = await loginRes.json().catch(() => null);
  if (!loginRes.ok) {
    const reason = loginData?.details?.find?.((d) => typeof d?.reason === "string")?.reason;
    const map = {
      invalidAccountOrPassword: t.loginInvalidAccount,
      IncorrectPassword: t.loginBadPassword,
      NotFound: t.loginNoAccount,
      LoginLocked: t.loginLocked,
      PermissionDenied: t.loginNoPermission,
      OperationTooFrequently: t.loginTooFrequent,
    };
    throw new QuotaError(map[reason] || fill(t.loginRejected, { status: loginRes.status }));
  }
  const next = typeof loginData?.redirect === "string" ? loginData.redirect.trim() : "";
  if (!next) throw new QuotaError(t.noRedirect);

  // 跟着跳转链走，直到某一跳的 Location 里出现授权码
  let url2 = next;
  for (let i = 0; i < 10; i++) {
    const r = await hop(url2, jar, fetchImpl, { headers: { Accept: "text/html,application/json" } });
    const loc = r.headers.get("location");
    if (!loc) throw new QuotaError(fill(t.chainStuck, { where: String(url2).slice(0, 100) }));
    const abs = new URL(loc, url2).href;
    const found = codeOf(abs);
    if (found) return exchangeCode(cfg, { code: found, verifier, redirectUri }, fetchImpl, t);
    if (/login_challenge=/.test(abs)) throw new QuotaError(t.bouncedToLogin);
    url2 = abs;
  }
  throw new QuotaError(t.chainTooLong);
}

/**
 * 保证 cfg.access_token 可用，必要时续期。
 *
 * @param {object} cfg - 凭据，会被就地更新。
 * @param {{fetchImpl?: Function, now?: number, strings?: object}} [opts] - strings 决定错误信息的语言。
 * @returns {Promise<boolean>} 是否更新过凭据（需要写回文件）。
 */
export async function ensureToken(cfg, { fetchImpl = fetch, now = Date.now(), strings } = {}) {
  const t = strings ?? tableFor("zh");
  if (cfg.access_token && !isExpired(cfg, now)) return false;
  if (cfg.refresh_token) {
    try {
      await refreshWithRefreshToken(cfg, fetchImpl, t);
      return true;
    } catch (e) {
      if (!cfg.cookie && !cfg.password) throw e;
    }
  }
  if (cfg.cookie) {
    try {
      await renewWithCookie(cfg, fetchImpl, t);
      return true;
    } catch (e) {
      if (!cfg.password) throw e;
    }
  }
  if (cfg.username && cfg.password) {
    await renewWithPassword(cfg, fetchImpl, t);
    return true;
  }
  throw new QuotaError(t.noRenewalPath);
}

/* ------------------------------------------------------------------ 取数 */

/**
 * 直接调控制台接口拿积分池原始数据。
 *
 * 响应形状：`{ plan: {id, name, type}, pools: [...] }`。每个池带
 * `model_ids`（这个池覆盖哪些模型）、`pool_type`、`grant_balance` 和两个窗口。
 *
 * **注意这里没有 API Key 这个维度** —— 额度是账户级的，同账户所有 Key 共享
 * （控制台横幅原话：「同账户所有 Key 共享」）。按 Key 的拆分只存在于「使用明细」
 * 里，那是逐条调用记录，不是额度。
 */
export async function fetchPoolUsage(cfg, { fetchImpl = fetch, strings } = {}) {
  const t = strings ?? tableFor("zh");
  const base = (cfg.base || DEFAULT_BASE).replace(/\/$/, "");
  const url = `${base}/lite/console/v1/tokenplan/pool-usage`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      Accept: "application/json",
      // 实测这个头目前不影响返回（池名恒为中文），但声明真实语言总比谎报 zh-CN 好。
      "Accept-Language": t.locale === "en" ? "en-US" : "zh-CN",
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const reason = data?.details?.find?.((d) => typeof d?.message === "string")?.message;
    throw new QuotaError(`${fill(t.quotaHttp, { status: res.status })}${reason ? ` ${reason}` : ""}`);
  }
  return {
    plan: data?.plan ?? null,
    pools: Array.isArray(data?.pools) ? data.pools : [],
  };
}

/* ------------------------------------------------------------------ 映射 */

/**
 * 把积分池映射成 Magpie 的 quota 结构。
 *
 * Magpie 的额度模型是「窗口」：`used` 是已用百分比，`amount` 是已用数量，
 * `limit` + `unit` 是配额，`span` 是窗口长度（秒），`resetsAt` 是重置时间。
 * SenseNova 的 5 小时窗口（18000 秒）和周期窗口（604800 秒）正好一一对应。
 *
 * 窗口归属哪个模型，直接用接口给的 `model_ids`（`models` 字段，语义是「恰好
 * 这些 id」），而不是按名字猜——专属池的 `model_ids` 就是
 * `["sensenova-6.7-flash-lite","sensenova-6.8-flash-lite"]`，服务器自己声明
 * 的比任何启发式都准。只有拿不到 `model_ids` 时才退回按关键词匹配。
 *
 * **`amount` 是关键**：Magpie 的界面按「已用 / 配额」渲染，并且有一个
 * 「已用 | 剩余」的切换，两边都从 `amount` 算。只给 `used` 不给 `amount`
 * 的话，百分比是对的，数量却会显示成 0 —— 界面上看起来就是「0 / 600,000」，
 * 和真实余额完全对不上。这个字段没有出现在公开文档的窗口字段列表里，是从
 * workbuddy / zcode 两个社区插件的实现里对出来的。
 *
 * @param {{plan?: object, pools?: Array<object>}|Array<object>} usage - fetchPoolUsage 的结果（或裸 pools 数组）。
 * @param {{scopeModel?: string, strings?: object}} [opts] - strings 决定标签与单位的语言。
 * @returns {{plan?: string, windows: Array<object>, balance?: string}}
 */
export function toQuota(usage, opts = {}) {
  const pools = Array.isArray(usage) ? usage : usage?.pools;
  const plan = Array.isArray(usage) ? null : usage?.plan;
  const windows = [];
  let balance;
  const scopeModel = opts.scopeModel ?? "flash-lite";
  const t = opts.strings ?? tableFor("zh");

  for (const pool of pools || []) {
    const dedicated = pool.pool_type === "dedicated";
    const label = poolLabel(pool.name, t, dedicated);
    const modelIds = Array.isArray(pool.model_ids) ? pool.model_ids.filter((x) => typeof x === "string") : [];
    const scope = modelIds.length
      ? { models: modelIds }
      : dedicated && scopeModel
        ? { model: scopeModel }
        : {};

    for (const [field, span, wname] of [
      ["window_5h", 18000, t.window5h],
      ["window_7d", 604800, t.windowWeekly],
    ]) {
      const w = pool[field];
      if (!w) continue;
      const limit = Number(w.limit);
      const remaining = Number(w.remaining);
      if (!Number.isFinite(limit) || limit <= 0) continue;
      // Without `remaining` the usage is unknown, and defaulting it to 0 would
      // put a fabricated "0 / limit" on the card — the same wrong-number failure
      // `amount` was added to fix. Report nothing for this window instead.
      if (!Number.isFinite(remaining)) continue;
      const amount = Math.max(0, limit - remaining);
      const resetsAt = Number(w.reset_at);
      windows.push({
        name: `${label} · ${wname}`,
        used: Number(((amount / limit) * 100).toFixed(4)),
        amount,
        limit,
        unit: t.unit,
        display: `${compact(amount)} / ${compact(limit)}`,
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        span,
        ...scope,
      });
    }

    const grant = Number(pool.grant_balance);
    if (!dedicated && Number.isFinite(grant) && grant > 0) {
      balance = `${fmtNum(grant)} ${t.unit}`;
    }
  }

  const planName = typeof plan?.name === "string" && plan.name.trim() ? plan.name.trim() : undefined;
  return {
    ...(planName ? { plan: planName } : {}),
    windows,
    ...(balance ? { balance } : {}),
  };
}

/**
 * 一步到位：确保 token、拉数据、映射成 quota。
 *
 * @param {object} cfg - 凭据（会被就地更新，调用方负责写回）。
 * @param {{fetchImpl?: Function, now?: number, scopeModel?: string, strings?: object}} [opts]
 */
export async function readQuota(cfg, opts = {}) {
  const { fetchImpl = fetch, now = Date.now(), scopeModel, strings } = opts;
  const changed = await ensureToken(cfg, { fetchImpl, now, strings });
  const usage = await fetchPoolUsage(cfg, { fetchImpl, strings });
  return { quota: toQuota(usage, { scopeModel, strings }), changed, usage };
}
