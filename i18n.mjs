/**
 * UI strings, in the two languages the platform serves.
 *
 * Magpie exposes no locale to a plugin and gives a plugin no way to add settings
 * UI, so the language is an option on this plugin (`locale`) that defaults to
 * following the machine. The labels this file produces are not decoration: they
 * land in Magpie's own account card and in `magpie quota`.
 *
 * Why the plugin has to translate at all: the console's quota endpoint returns
 * its pool names in Chinese no matter what `Accept-Language` says. Observed on a
 * real account — `zh-CN` and `en-US` both answer `["通用积分池","Flash-Lite积分池"]`.
 * The console's English site shows "General Pool" and "Flash-Lite Dedicated
 * Pool", so that translation happens in its frontend, not on the wire.
 *
 * @module magpie-sensenova/i18n
 */

/** The languages with a string table here. */
export const LOCALES = ["zh", "en"];

const ZH = {
  locale: "zh",

  poolGeneral: "通用积分池",
  poolDedicated: "专属积分池",
  window5h: "5 小时窗口",
  windowWeekly: "本周",
  unit: "积分",
  planFallback: "Token Plan",

  noAccount: "没有可用于读取额度的 SenseNova 账号。在插件里补填账号密码，或先运行 snquota login。",
  readFailed: "读取额度失败: {detail}",
  refreshFailed: "refresh_token 续期失败: {detail}",
  exchangeFailed: "用授权码换令牌失败: {detail}",
  cookieDead: "会话 cookie 已失效，请重新导出或用账号密码登录",
  noAuthCode: "授权端点没有返回授权码（HTTP {status}）",
  noChallenge: "授权端点没有返回 login_challenge（HTTP {status}）",
  challengeExpired: "login_challenge 已失效，请重试",
  noRedirect: "登录接口没有返回 redirect",
  chainStuck: "登录跳转链在 {where} 停住了",
  bouncedToLogin: "登录后又被踢回登录页，账号密码可能不对",
  chainTooLong: "登录跳转次数超出上限",
  loginRejected: "登录被拒绝（HTTP {status}）",
  quotaHttp: "读取额度失败 HTTP {status}",
  noRenewalPath: "access_token 已过期，且没有 refresh_token / 会话 cookie / 账号密码可用。请运行 snquota login 重新登录。",

  loginInvalidAccount: "账号或密码不正确",
  loginBadPassword: "密码不正确",
  loginNoAccount: "账号不存在",
  loginLocked: "账号被锁定",
  loginNoPermission: "该账号没有权限",
  loginTooFrequent: "操作过于频繁",

  methodLabel: "SenseNova API Key（控制台 → API-Key 管理）",
  promptAccount: "可选：SenseNova 账号，用来读取控制台积分额度（留空则读 snquota 已存的凭据）",
  promptPassword: "可选：账号密码（明文保存在本机 plugin-auth.json，仅用于读取额度）",
  placeholderAccount: "手机号 / 邮箱",
  placeholderPassword: "留空 = 不保存密码",
};

const EN = {
  locale: "en",

  poolGeneral: "General Pool",
  poolDedicated: "Dedicated Pool",
  window5h: "5h window",
  windowWeekly: "This week",
  unit: "credits",
  planFallback: "Token Plan",

  noAccount: "No SenseNova account available to read the quota. Fill in an account in the plugin, or run snquota login first.",
  readFailed: "Quota read failed: {detail}",
  refreshFailed: "refresh_token renewal failed: {detail}",
  exchangeFailed: "Exchanging the authorization code for a token failed: {detail}",
  cookieDead: "The session cookie has expired; export it again or sign in with the account password",
  noAuthCode: "The authorization endpoint returned no code (HTTP {status})",
  noChallenge: "The authorization endpoint returned no login_challenge (HTTP {status})",
  challengeExpired: "The login_challenge has expired; try again",
  noRedirect: "The sign-in endpoint returned no redirect",
  chainStuck: "The sign-in redirect chain stopped at {where}",
  bouncedToLogin: "Bounced back to the sign-in page after signing in; the account or password may be wrong",
  chainTooLong: "The sign-in redirect chain exceeded its hop limit",
  loginRejected: "Sign-in refused (HTTP {status})",
  quotaHttp: "Reading the quota failed with HTTP {status}",
  noRenewalPath: "The access_token has expired and there is no refresh_token, session cookie, or account password to renew it with. Run snquota login to sign in again.",

  loginInvalidAccount: "Wrong account or password",
  loginBadPassword: "Wrong password",
  loginNoAccount: "No such account",
  loginLocked: "The account is locked",
  loginNoPermission: "This account has no permission",
  loginTooFrequent: "Too many attempts",

  methodLabel: "SenseNova API key (console → API-Key management)",
  promptAccount: "Optional: the SenseNova account used to read the console's credit quota (blank reads the credentials snquota already stored)",
  promptPassword: "Optional: the account password (stored in plaintext in this machine's plugin-auth.json, used only to read quota)",
  placeholderAccount: "phone / email",
  placeholderPassword: "blank = do not store a password",
};

const TABLES = { zh: ZH, en: EN };

/**
 * Fill `{name}` placeholders. Unknown names are left as they are, so a missing
 * string shows up in the UI instead of turning into "undefined".
 */
export function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? String(values[key]) : whole
  );
}

/** The table for a resolved locale. */
export function strings(locale = "zh") {
  return TABLES[locale] ?? ZH;
}

/** The OS locale as Node reports it, or "" when there is nothing to report. */
function osLocale() {
  try {
    return typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : "";
  } catch {
    return "";
  }
}

/**
 * Decide the locale.
 *
 * `Intl` first, because it reflects the OS setting on every platform including
 * Windows, where `LANG` is usually `C.UTF-8` or unset and would be a lie. The
 * environment is only a fallback, for a Node built without full ICU (where
 * `Intl` reports its own default rather than the machine's) or an environment
 * that sets `LC_ALL` deliberately; a POSIX `C`/`POSIX` value is skipped rather
 * than read as "not Chinese, therefore English".
 *
 * @param {string|undefined} value - the `locale` option: `"auto"`, `"zh"`, or `"en"`.
 * @param {object} [env] - environment to read, injected for testing.
 * @param {string} [intl] - the OS locale, injected for testing.
 * @returns {"zh"|"en"}
 */
export function resolveLocale(value, env = process.env, intl = osLocale()) {
  if (value === "zh" || value === "en") return value;
  if (value && value !== "auto") {
    const explicit = String(value).toLowerCase();
    if (explicit.startsWith("zh")) return "zh";
    if (explicit.startsWith("en")) return "en";
  }

  if (/^zh/i.test(intl)) return "zh";
  if (/^en/i.test(intl)) return "en";

  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    const tag = raw.trim().split(".")[0].split("_")[0].toLowerCase();
    if (!tag || tag === "c" || tag === "posix") continue;
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

/**
 * A pool name from the API, in the requested language.
 *
 * The endpoint answers in Chinese whatever `Accept-Language` says, so English
 * comes from the naming rule the console itself uses: a dedicated pool is
 * "<family>积分池", and the console renders that "<family> Dedicated Pool"
 * (`Flash-Lite积分池` → `Flash-Lite Dedicated Pool`, as its English site shows).
 *
 * The shared pool is the exception, and it is why this branches on `dedicated`
 * rather than translating every name: its label is this plugin's own generic
 * one, not the API's string. Running the suffix rule over the API's
 * `通用积分池` would produce the nonsense "通用 Dedicated Pool".
 *
 * A dedicated name that does not match the rule is passed through untouched
 * rather than mangled, and a missing one falls back to the generic label.
 *
 * @param {string|undefined} name - `pool.name` from the endpoint.
 * @param {object} t - the string table.
 * @param {boolean} dedicated - whether the pool is model-scoped.
 */
export function poolLabel(name, t, dedicated) {
  if (!dedicated) return t.poolGeneral;
  const raw = typeof name === "string" ? name.trim() : "";
  if (!raw) return t.poolDedicated;
  if (t.locale === "zh") return raw;
  // The API has answered both "Flash-Lite积分池" and "Flash-Lite 专属积分池"
  // depending on the response, so accept the optional 专属 rather than leaving
  // it stranded inside an otherwise-English label. Collapsing the spaces keeps
  // the "Flash-Lite " prefix from doubling up with the replacement.
  if (/(?:专属)?积分池$/.test(raw)) {
    return raw.replace(/(?:专属)?积分池$/, " Dedicated Pool").replace(/\s+/g, " ").trim();
  }
  return raw.replace(/\s+/g, " ").trim();
}
