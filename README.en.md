# magpie-sensenova

[中文](./README.md) | **English**

A [Magpie](https://usemagpie.ai) provider plugin for **SenseNova** (商量 / 日日新, SenseTime):
it brings the Token Plan models in over the OpenAI-compatible API, and reports the console's
**credit quota** as native Magpie quota windows.

> **This is the SenseNova Token Plan (the developer API, `platform.sensenova.cn`) — not SenseTime's
> Raccoon.** SenseTime runs two services for two audiences: this plugin talks to the Token Plan API for
> developers; the consumer chat app is **SenseTime Raccoon** (商汤小浣熊, `xiaohuanxiong.com`), which is a
> different service with its own accounts and credits, served by
> [`@magpie-community/opencode-raccoon-auth`](https://github.com/magpie-community/plugins). Balances,
> check-ins and model lists do not carry over between the two.

```
$ magpie quota
sensenova  通用积分池 · 5 小时窗口   0% used ↻ 2h  ·  Flash-Lite积分池 · 5 小时窗口  22.8% used ↻ 2h
```

(The window labels come from the platform's pool names, passed through and translated by this plugin — see
[`locale`](#locale). The example above is the Chinese default.)

### What the account row shows

Magpie names an account from `accountId`, then `metadata.email`, then `email`, and only when none of those
exist does it fall back to labelling the account by the credential — the `API key …HohJ` you may have seen.

So the label is fixed **at sign-in**, from what you type there: fill in the account field and the row shows
that phone number or email; leave it blank and the row keeps Magpie's API-key fallback.

Getting an `api`-type method to set it took some measuring, and the findings are worth recording because two
plausible approaches do not work:

- **The prompt's `key` is what decides it.** This plugin asks for the account under the key `email`, so the
  answer lands in `metadata.email` — the field Magpie reads. Verified end to end: a sign-in with the account
  field set to `139…7777` produced a row labelled exactly that.
- **`accountId` returned from `authorize` is ignored** for an `api`-type method. It is documented for oauth
  results, and a sign-in that carried it still came out labelled `API key`.
- **A `metadata` object returned from `authorize` is discarded.** Magpie replaces it with the answers the
  prompts collected, so an `email` planted there never survives.
- **`usage.user` does not rename the row either.** A `user` from the hook is stored in Magpie's quota cache
  (`quotas.json` → `quota.user`) while the row and `magpie quota` keep rendering the login-time label; the
  cache key stays `sensenova/api key …hohj` either way.

Older sign-ins stored the account under `metadata.username`, so `consoleAuthOf` still reads that spelling
(and `account`) as a fallback. Those accounts do not need re-signing in either — see below.

**An account signed in before this existed does not need re-signing in.** Magpie migrates the legacy
`metadata.username` into `metadata.email` itself: the older entries here were observed going from
`username` alone, to both fields present, to `email` alone, and the account row then renders the account
name. Watching a real install, `sensenova · Free Plan · API key …HohJ` turned into
`sensenova · Free Plan · Rina49` without a new sign-in.

---

## ⚠️ Security notice — read this first

**This plugin is a local third-party client. It is not affiliated with SenseTime.** Every point below
says where its evidence comes from, in one of three kinds:

- **observed** — a measurement against the real API or this machine, with the command or symptom;
- **console code** — a quotation from SenseNova's own console frontend;
- **plugin code** — what this repository's source actually does, with file and function.

The first two describe the outside world and can be invalidated by a platform change. The third
describes this package and moves with its version. **If something labelled "plugin code" disagrees with
what you observe, trust the code and open an issue.**

### 1. What is stored, and where

Two credential sets, with very different scopes:

| Credential | Stored in | Fields | What it can do |
| --- | --- | --- | --- |
| API key | `~/.config/magpie/plugin-auth.json` | `key` (`type: "api"`) | Call the Token Plan models |
| Account + password (only if you supply them) | same file, under `metadata` | `metadata.username` / `metadata.password` | **The whole account** |
| Console OAuth tokens | same file's `metadata`, or `~/.sensenova-quota.json` | `access` / `refresh` / `cookie` / `iamBase` | Read quota, renew tokens |
| Session cookie (only if you supply it) | as above | `metadata.cookie` | Trade for console tokens without a password |

**The account password does more than read quota.** It can sign in to the SenseNova console, create and
delete API keys, and do anything else that account can do. Handing it to the plugin means handing the
whole account to Magpie's credential file — the heaviest permission this plugin asks for. **Leaving it
blank works fine** (see 5).

The account and password in `metadata` have two possible origins, both consented to: what you typed into
the plugin's sign-in prompt, or what you previously saved to `~/.sensenova-quota.json` with
`snquota login --save-password` (the plugin reads that file when it exists). **It does not scrape
credentials from a browser, the system keychain, or another provider's sign-in**, and it does not write
to any credential setting on SenseNova's servers.

**One local file does get written, and it should be stated:** console tokens live in
`~/.sensenova-quota.json` under **that account's own entry**, `accounts.<account name>` — with the API
key's fingerprint standing in when no account was named. Quota is account-level and one token belongs to
one console account, so a single shared record could only ever represent whichever account signed in last,
which is exactly what made several account rows show one and the same figure.

The file's top-level record is the `snquota` CLI's single-account one: it is **read**, and refreshed only
when it is the record this account has been reading, so the CLI's copy does not go stale in the one-account
case. (The `credentialsFile` option only redirects where that happens; it does not turn it off.)

### 2. The password is stored in plaintext

**The content is not encrypted.** It is plain JSON. That part is platform-independent.

As for who can read it, do not rely on file permissions to save you. On Linux and macOS Magpie creates
it as 600 (readable only by you), but on Windows that protection does not actually land — measured on
this machine, both `plugin-auth.json` and `~/.sensenova-quota.json` have an effective mode of `666`, and
the `-rw-r--r--` that `ls -l` prints is a Git Bash fabrication. The real ACL looks like this:

```
<your account>          FullControl
<some local group>      Modify        ← more than just you can read it
NT AUTHORITY\SYSTEM     FullControl
BUILTIN\Administrators  FullControl
```

In other words, any process running as you, or as a member of that group, can read the password.
**The password's security boundary is "every local process on this machine", not "only you".**

The practical advice is therefore: keep these two paths out of cloud-sync folders, backup jobs, and
dotfiles repositories. Once the password rides along in a backup, it travels in plaintext.

### 3. The password travels in plaintext, unlike the browser's

The **console code** looks like this (`U` encrypts, `h.bK` is the sign-in request):

```js
// When the JWKS is available, encrypt with the server's public key before submitting
if (s) { let t = await U(s, e.password); t && (r = t, a = !0) }
await h.bK({ username: e.username, password: r, challenge: t, is_encrypt: a })
```

The browser sends `is_encrypt: true` with an RSA-OAEP (JWE, `alg: RSA-OAEP, enc: A256GCM`) ciphertext.
**This plugin sends plaintext (`is_encrypt: false`)** — this part is **observed**: the server accepts it
and does not require encryption.

Both end up as plaintext on the server, which is what it needs in order to check the password. The
difference is **how much of the path is exposed**: HTTPS still protects the transport, but anything that
can see TLS plaintext — a corporate proxy, a packet capture, request-body logging — can see the
password. If you are behind one of those, do not fill in the password.

### 4. The password is almost never used

The renewal order is `refresh_token` → session cookie → account password, and **the first step that
succeeds stops the chain**. As long as the refresh token is alive, the password is never sent at all. It
is only a fallback for when the refresh token has died.

### 5. If you would rather not store a password, leave it blank

Both the account and password fields at sign-in can be left empty. Three ways to run this, and what each
costs you:

| Approach | What lands where | For whom |
| --- | --- | --- |
| **API key only** | Just `key` | You want model calls and do not care about the quota display |
| **Leave account and password blank** | The plugin reads `~/.sensenova-quota.json`, written by the `snquota` CLI (usually holds a refresh token) | You want the quota shown but will not hand the account password to Magpie |
| **Fill in the account** | Plaintext into `plugin-auth.json` | You have no other token source and accept the risks in 1 and 7 |

If you leave them blank and that config file does not exist either, the quota reports an error asking you
to sign in — **model calls are unaffected either way.**

### 6. Which hosts it talks to, and no telemetry

On the default deployment (`platform.sensenova.cn`) there are three:

| Host | Purpose | What is sent |
| --- | --- | --- |
| `token.sensenova.cn` | Model requests, model listing | API key |
| `platform.sensenova.cn` | Reading quota; the icon URL also lives here | Console token |
| `iam.sensecoreapi.cn` | Renewing the console token | Account and password (only in the fallback case in 4) |

There is a fourth in the source: `iam.sensecoreapi.tech`. It is the IAM base for a **separate
deployment**, `nova.sensecore.tech`, and is only reached when the account belongs to that deployment
(`iam_base` overrides it). If you are on `platform.sensenova.cn`, it never appears.

Nothing else is sent anywhere — no telemetry, no reporting, no third-party SDK. It **does not read other
providers' credentials** (it technically could read the same `plugin-auth.json`, see 7; the point is
that the code does not, not that the environment prevents it), does not touch configuration outside
Magpie, and does not create or delete API keys (the console token could, but the plugin only calls the
one read-only endpoint).

Quota reads are cached for 60 seconds by default (`quotaTtlMs`), so a polled `usage` hook does not hammer
the endpoint.

### 7. What Magpie — and other plugins — can see

Magpie's own documentation has this in its FAQ:

> **What can a plugin see about the user?** Everything in the requests it makes: the conversation, the
> tools and their results. Send it only where the user asked, and do not put it in a log.

That applies to this plugin too, and it has to be spelled out: **this is a provider plugin, so it sits in
the request path.** It registers a provider and wraps `fetch`, swapping the `authorization` header for
the current API key before the request leaves:

```js
async fetch(input, init) {
  const headers = new Headers(init?.headers ?? source?.headers);
  headers.set("authorization", `Bearer ${current}`);
  return fetch(new Request(source, { ...init, headers }));   // body passes through
}
```

So by capability it **is positioned to see your entire conversation, your tool calls, and their
results.**

What the code actually does: **it reads headers and rewrites the single `authorization` field**, does not
read the request body (the `body` is carried through by `{...init}`), does not write the content
anywhere, does not cache prompts or responses, and does not send anything to a host outside the list in
6. **But that is the code restraining itself, not isolation granted by the platform** — you can only
confirm it by reading the code, and Magpie cannot guarantee it for you.

Three facts about Magpie's plugin mechanism decide how much that restraint is worth:

- **Plugins are not sandboxed.** A plugin is ordinary code running inside Magpie's process, and it can
  read files with `fs`. Magpie's documentation recommends "running magpie in a sandbox" with a separate
  HOME for exactly this reason.
- **Plugins are not reviewed.** For plugins installed from the GitHub topic, Magpie explicitly labels
  them as reviewed by nobody. This plugin is unvetted third-party code in the same way.
- **Every plugin's credentials live in one file.** `plugin-auth.json` is a single file holding the
  sign-in for every provider and every plugin, not one file per plugin. Since plugins are unsandboxed and
  have `fs`, **any other plugin you install can read the account password this one stored there.** This
  is the single most important consideration when deciding whether to fill in a password — if there are
  plugins of unknown provenance on the machine, leave it blank (see 5).

Magpie itself reads `plugin-auth.json` (to manage sign-ins), `plugins.json` (plugins and their options),
and `plugin-providers.json` (the last listed providers and models). And **the plugin detail page shows
the README from npm** — so this README is this plugin's only disclosure surface, which is why every point
here is written to be checkable.

### 8. Risk statement: the quota endpoint is a console-internal API, not a public one

The quota figure is served by an endpoint on the console host that **the console's own frontend** uses to
draw its credit panel. It is undocumented, and it can change or disappear at any time. The exact path is
deliberately not written down here; it is in `quota.mjs` if you need to see it.

That route exists because the platform **offers no API-key-accessible quota endpoint at all** —
**observed**: a dozen candidate paths on the public LLM host (`/v1/llm/usage`, `/v1/llm/quota`,
`/v1/llm/balance`, `/v1/dashboard/billing/subscription`, and others) all return 404.

**The risk is not limited to "it might break".** Stated plainly:

| Risk | What it means |
| --- | --- |
| **It may breach the terms of service** | The endpoint is the console frontend's own, not a promised API. Whether scripted access is permitted is the platform's call, and **you should confirm it yourself**. This plugin neither changes nor circumvents any term. |
| **It may stop working** | An undocumented endpoint makes no compatibility promise. A redesign, a signature requirement, or rate limiting could turn it into a 404 or 403, at which point the quota display reports an error (model calls are unaffected). |
| **It may trip abuse controls** | Automatic sign-in plus periodic quota reads look like a non-standard client from the server's side. This plugin already caches quota reads for 60 seconds and demotes the password to a last resort in order to keep the footprint small, but **it cannot promise you will not be flagged.** |
| **It widens credential exposure** | Reaching this endpoint requires holding a console token (and optionally an account password). That part of the risk is covered by 1 through 7. |

Of these four, the first is the only one that needs your judgement — the plugin can handle the technical
ones, not the compliance one. **If that bothers you, do not use the quota feature**: with only an API key
filled in, the plugin degrades to a plain model provider and never touches the console API, and risks 2
through 4 go away with it.

### 9. What it does not do

- It does not request, rotate, or revoke your API keys.
- It does not change your SenseNova account settings.
- It does not read, log, or forward your model request content — it rewrites the single `authorization`
  header and passes the body through to `token.sensenova.cn` (see the code in 7).
- It does not cache prompts or responses.
- It does not write to any credential setting on SenseNova's servers.
- It writes to `~/.sensenova-quota.json` only its own per-account entries (`accounts.<account>`) plus,
  when that is the record it read from, the CLI's top-level single-account record — nothing else.

---

## Two things, one package

The platform puts these two in completely different places, so the plugin does two things at once:

| | Where | Auth |
| --- | --- | --- |
| **Model calls** | `https://token.sensenova.cn/v1` (OpenAI-compatible) | API key |
| **Credit quota** | An internal API on the console host | Console OAuth token |

**There is no API-key-accessible quota endpoint.** A dozen candidate paths were probed one by one and all
returned 404; the quota exists only behind the console's own endpoint, which needs an Ory bearer token.
So the two credentials are **genuinely independent**, and the plugin collects both at sign-in.

---

## Where the quota is reported

Magpie's plugin system **does not let a plugin add panels or pages**, and nothing can feed content into
the usage-overview analytics page — that is driven by Magpie's own request metering.

The only quota channel a plugin has is `auth.usage`. What it returns shows up in three places:

- the provider's **account row**
- `magpie quota`
- the gateway's `GET /v1/magpie/quotas`

The good news is that Magpie's quota model maps almost one-to-one onto SenseNova's data, so nothing is
lost:

| SenseNova | Magpie |
| --- | --- |
| General pool, 5-hour window (`window_5h`) | one `windows[]` entry, `span: 18000` |
| General pool, this week (`window_7d`) | one `windows[]` entry, `span: 604800` |
| Which models a pool covers (`model_ids`) | `models[]` (meaning "exactly these ids") |
| Plan name (`plan.name`, in practice `Free Plan`) | `plan` |
| Granted credit balance (`grant_balance`) | `balance` |
| Window reset time (`reset_at`) | `resetsAt` (a Unix timestamp in seconds) |

Model scoping uses the server's own `model_ids` rather than guessing from names — the dedicated pool's
`model_ids` is `["sensenova-6.7-flash-lite","sensenova-6.8-flash-lite"]`, which beats any keyword
matching (the plugin only falls back to matching `flash-lite` when `model_ids` is absent). The plan name
works the same way, taken from the endpoint's `plan.name`.

### ⚠️ `amount` is required, and the docs do not say so

Besides `used` (percent used) and `limit` (the allowance), every window must carry **`amount` (the used
quantity)**.

This was learned the hard way: with only `used` and `limit`, the percentage is right but the number in
the UI reads `0 / 600000` — which looks nothing like the real balance. Magpie renders the card as
"used / limit" and offers a "used | remaining" toggle, and both are computed from `amount`; without it,
the count is simply treated as 0.

The field **is not in the plugin documentation's list of window fields** (the docs list only
`name`/`used`/`resetsAt`/`resetSecs`/`span`/`display`/`model`/`models`/`notModels`/`aside`). It was
recovered by reading two community plugins — `@magpie-community/opencode-workbuddy-auth` and
`opencode-zcode-auth` both set it, and the latter's comment states its purpose:

> the count is told carries it as **amount of limit**, so magpie's card says …

So every window this plugin emits carries `used` (percent), `amount` (used quantity), `limit`, `unit`,
`display`, `span`, `resetsAt`, plus `models` on the dedicated pool. `display` is generated with Magpie's
own compact formatting (`compact()`: integers as integers, otherwise two decimals) so it lines up with
`amount`/`limit` when rendered side by side.

Reconciling is easy: `limit - amount` must equal the console's displayed weekly remaining balance.
**Observed**: all four windows match exactly.

---

## Install

```bash
magpie plugin add <path to this repository>
magpie plugin login sensenova
```

Sign-in asks three questions:

1. **SenseNova API key** (required) — console → API-Key management. Without it the provider cannot make
   any request.
2. **Account** (optional) — used to read the console's credit quota.
3. **Password** (optional) — same.

Questions 2 and 3 are the plugin's own, declared in its `prompts`. **Question 1 is Magpie's**: an `api`
-type method gets its credential asked for and stored by the host, which is why this plugin does not declare
a `key` prompt of its own. Earlier versions did, and asked for the same secret twice — the duplicate is
gone, so a sign-in is now those three questions and nothing more. `placeholder` on the method is what
Magpie shows for its own question.

Leaving the last two blank is fine: the plugin falls back to `~/.sensenova-quota.json`, written on this
machine by the `snquota` CLI.

### If the prompts fail on Windows

Magpie's prompt reader wants a real Windows console. Started from a shell that does not give it one — Git
Bash/mintty is the usual case — the first prompt dies with

```
magpie: read /dev/stdin: The handle is invalid.
```

That is Magpie's own host code reading its standard input (`/dev/stdin` is Go's name for it), not this
plugin: every package using a text prompt behaves the same way. Two ways round it.

**Answer on the command line instead.** Piped input works, and the answers are read in prompt order — key,
account, password. The trailing line matters: with only three lines the reader runs out before the last
prompt and reports EOF.

```bash
printf '%s\n%s\n%s\n.\n' "$SENSENOVA_API_KEY" "$ACCOUNT" "$PASSWORD" | magpie plugin login sensenova
```

**Or use the Magpie app's own sign-in**, which does not go through the CLI reader at all.

### About those two console credentials

The quota endpoint wants a console token, and that token expires in about 2.4 hours. The plugin
implements three renewal paths, in order of reliability:

1. `refresh_token` (the standard renewal)
2. Browser session cookie (replaying the authorization-code + PKCE flow)
3. Account and password (a full automated sign-in: `login_challenge` → challenge check → submit →
   follow the redirect chain → exchange for a token)

If you already use the `snquota` CLI, the simplest arrangement is to let the plugin read that config, so
both share one set of credentials:

```bash
snquota login --username <your account> --password <your password> --save-password
```

**The password is stored in plaintext in `plugin-auth.json`** (storage and permission details are in 2
above). If that is not acceptable, do not fill in a password — use a cookie, or let the plugin read the
`snquota` config.

---

## Configuration

The `options` for this entry in `plugins.json`:

```json
{
  "spec": "…/magpie-sensenova",
  "options": {
    "baseURL": "https://token.sensenova.cn/v1",
    "quotaTtlMs": 60000,
    "scopeModel": "flash-lite",
    "locale": "auto",
    "credentialsFile": "~/.sensenova-quota.json"
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://token.sensenova.cn/v1` | Token Plan address |
| `quotaTtlMs` | `60000` | How long a quota read is cached. `usage` gets polled; the cache keeps the endpoint from being hammered |
| `scopeModel` | `flash-lite` | Which keyword scopes the dedicated pool's models |
| `locale` | `auto` | `zh`, `en`, or `auto` to follow the machine. See below |
| `credentialsFile` | `~/.sensenova-quota.json` | Where the console credentials live |

### `locale`

Magpie exposes no locale to a plugin and gives a plugin no settings UI, so the language of everything this
plugin renders — quota window labels, units, error messages, and the sign-in prompts — is set here. Change
it and Magpie picks the new strings up on the next load:

```bash
magpie plugin options sensenova '{"locale":"en"}'
```

`auto` (the default) reads the OS locale through `Intl`, which is what reflects the setting on Windows;
`LANG` is only consulted when `Intl` has nothing to say, so a Git Bash `LANG=C.UTF-8` does not flip a
Chinese machine to English. Anything unrecognised falls back to English.

The translations are the console's own wording, taken from
[its English site](https://platform.sensenova.cn/en/console), not invented: it calls the two pools
**General Pool** and **Flash-Lite Dedicated Pool**, and the unit **credits**. That translation has to
happen here because **the quota endpoint does not localise** — observed on a real account, `Accept-Language:
zh-CN` and `en-US` both answer `["通用积分池","Flash-Lite积分池"]`, so the console's English site is
translating in its own frontend.

The sign-in prompts are the one exception to switching freely: their answers are stored once, at sign-in,
so changing `locale` afterwards does not retranslate the questions you already answered.

---

## Quota and API keys: the quota is account-level

**The credit quota is not split per API key. Every key on the same account shares one pool.**

Three pieces of evidence:

1. The console's own banner says 「**同账户所有 Key 共享**」 ("shared by all keys on the account").
2. The quota endpoint's response has **no key dimension at all** — the top level is only `{plan, pools}`,
   and each pool carries `id`/`name`/`model_ids`/`window_5h`/`window_7d`/`grant_balance`/`pool_type`
   with no key identifier anywhere. What the plugin receives is an account-level number.
3. Per-key breakdown lives somewhere else: the console's **usage records** page. That endpoint supports
   filtering by `apiKey`, and each call record carries its key and can be exported as CSV or Excel.

So these are two different layers:

| | Dimension | What it is |
| --- | --- | --- |
| **Credit pool (what this plugin shows)** | Account-level | Shared by every key on the account; a key is an entry point, not a separate ledger |
| **Usage records** | Per call | Each record carries its key, filterable and exportable by key |

### More than one account

Because the quota is account-level, each SenseNova account needs its own console token. They are kept in
that account's own slot of the credentials file, keyed by the account name typed at sign-in (and by the API
key's fingerprint when none was typed), so two accounts read their own figures.

An account that names itself never borrows the CLI's single-account token: the slot is its name, the token
in the top-level record names the account it was issued to, and a mismatch means it is somebody else's. What
that prevents is the failure this used to have — every row reading the one shared token, the last account to
sign in winning, and `ensureToken` then short-circuiting on that unexpired token instead of ever signing in
as anyone else.

Sign in with the account field filled for each account you add, and they stay apart.

### What this means for Magpie in practice

The provider card is titled "API key …HohJ", but the quota it shows is **account-level**. So:

- Add **two keys from the same SenseNova account** and both rows show **exactly the same numbers**.
- Magpie's "when one runs out, switch to the next" behaviour fails in this case — it assumes each key has
  its own 600,000 allowance, when they actually share one pool. **Adding keys does not add quota.**
- More quota means **a different SenseNova account**.

---

## Icon

It uses the platform's own icon: `assets/sensenova.png` is the raw bytes of
`https://platform.sensenova.cn/favicon.ico`. That address is named `.ico` and served with an
`image/x-icon` header, but the payload is actually a 65×65 PNG, so the data URI declares `image/png` to
match the bytes rather than the header.

The icon is **vendored rather than referenced by URL** so the provider stays identifiable offline and
does not depend on the platform continuing to serve the file. The `magpie.icon` field in `package.json`
still points at that address, for the discovery card once this is published to npm.

---

## Models

The four ids in the built-in snapshot are not invented — they are what the platform's own usage report
emits (`credit-usage-trend`'s `series[].model_id`):

- `sensenova-6.8-flash-lite` (multimodal)
- `deepseek-flash`
- `glm-5.2`
- `kimi-k3`

After sign-in, `provider.models` uses the API key to fetch the live list from `GET /v1/models`. That
endpoint is richer than its OpenAI-shaped neighbours suggest: it returns **`context_length`**,
**`max_output_length`**, `input_modalities`, `output_modalities` and a **`supported_features`** list
(`tools`, `json_mode`, `reasoning`) for every model. So the model card here is read off the platform, not
guessed — the snapshot in `models.mjs` mirrors that response, and the table below is what it answers for
the current lineup:

| model | context | max output | input | features |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 1,048,576 | **393,216** | text | tools, json_mode, reasoning |
| `deepseek-v4.1-flash` | 1,048,576 | **393,216** | text | tools, json_mode, reasoning |
| `deepseek-v4-flash` | 1,048,576 | **384,000** | text | tools, json_mode, reasoning |
| `glm-5.2` | 1,048,576 | 131,072 | text | tools, json_mode, reasoning |
| `kimi-k3` | 1,048,576 | 65,536 | text | tools, json_mode, reasoning |
| `sensenova-6.8-flash-lite` | 262,144 | 65,536 | text, image | tools, json_mode, reasoning |

Three corrections went into this table, each found by asking the endpoint rather than trusting a number:

- The snapshot claimed 131,072 context and 32,768 output for all four models. The real ceilings are
  262,144 or 1,048,576 context, and 65,536 output — except `glm-5.2`, whose output ceiling is 131,072.
- `normalizeModel` looked for `max_completion_tokens` / `max_output_tokens` and never read the name the
  platform uses, **`max_output_length`**. Even with the live list in hand, every model came out at a 32,768
  output ceiling.
- **The catalogue's `max_output_length` is not the enforced ceiling.** Ask for an impossible `max_tokens`
  and the endpoint answers with its own valid range —
  `field MaxTokens invalid, should be in [1, 393216]`. That range is the real ceiling, and it disagrees
  with the catalogue for the DeepSeek models: `deepseek-flash` accepts **384K** while its catalogue entry
  claims **64K**, so the card was understating it sixfold. `MEASURED_OUTPUT_LIMITS` in `models.mjs` holds
  the upper bounds read this way; a model absent from it falls back to the catalogue. The two DeepSeek
  numbers differ by 3,216 because the endpoint reports 384×1024 for one and 384×1000 for the other.

`kimi-k3` is the one row still taken from the catalogue, because probing it kept answering
`429 inference exceeds tpm/rpm limit` rather than the range. Treat its 65,536 as the catalogue's word, not
a measurement.

**One model is deliberately not listed.** `/v1/models` also offers `sensenova-u1.5-lite`, but its
`output_modalities` is `["image"]` — it draws infographics — and `chat/completions` answers it with
`404 model is not found`. This plugin only serves chat, so it filters the list on "writes text"; offering
that model in a picker would only produce an error the user cannot explain.

**Reasoning effort.** Magpie expresses selectable effort levels as `variants` — a map from level names
(`low`/`high`/`xhigh`/`max`…) to the provider options for that level; other providers' entries in
`plugin-providers.json` carry them. SenseNova declares none: `/v1/models` lists only `temperature` and
`stop`
under `supported_sampling_parameters`, and its features are just `tools` / `json_mode` / `reasoning`. So
this plugin reports `reasoning: true` (the models do think) and **`variants: {}` — no effort selector**,
because there is nothing to select. If the platform later exposes one, `variants` is where it goes.

A live list is used when available; otherwise the plugin falls back and marks the list with Magpie's
fallback flag. Magpie also merges its own models.dev entry for `sensenova`, which is where
`deepseek-v4-pro` comes from when it appears.

---

## Known limits

- **The quota appears in exactly three places** — the account row, `magpie quota`, and
  `/v1/magpie/quotas` — and cannot be put into the usage overview. That is Magpie's design, not something this
  plugin failed to do.
- If the console token expires and all three renewal paths fail (refresh token revoked, cookie expired,
  wrong password), the account row shows an `error` asking you to sign in again.
- The quota endpoint is a console-internal API rather than a public one, so a redesign may break it.
- A model the platform adds after a release carries this plugin's default ceilings until the live
  `/v1/models` fetch replaces them, since only that endpoint knows the new model's numbers.
- No reasoning-effort selector: the platform exposes `reasoning` as a yes/no feature and nothing more, so
  `variants` is empty — see [Models](#models).
- **On the Free Plan, most requests to any model other than `sensenova-6.8-flash-lite` come back 429.**
  SenseTime gives the Free Plan a much smaller usage allowance for every model outside that one, which is
  metered against its own credit pool — the separate "Flash-Lite pool" the quota report shows. It is a
  throughput allowance rather than credits running out: the general pool has been reading under 2% used
  while `429 inference exceeds tpm/rpm limit` came back for `deepseek-flash`.
- **The plugin does not retry those, deliberately.** The response is handed back to Magpie exactly as it
  arrived. Retrying would barely help: the allowance runs on a minute-scale window, the `429` carries **no
  `Retry-After`**, and the same answer comes back after any wait — so a retry loop here would only hold the
  request open before failing anyway. What Magpie then does with it (resting the provider, trying another)
  is its own decision.
- A large `max_tokens` can be refused before it is even attempted, by the same per-minute metering: asking
  for 65,536 tokens answered `429` on an account whose only traffic was the question. The ceilings in
  [Models](#models) say what the endpoint accepts, not what the plan will serve at any given moment.
- **`magpie provider rest-cap` does not work for this provider, and it is a bug in magpie — not a setting
  you are missing.** Writing `restCap` / `quotaRest` for a plugin provider is accepted and does reach
  `~/.config/magpie/providers.json`, but it is ignored on read, so a rate-limited account still sits out
  magpie's defaults: 10 minutes, 30 when rate limited, and 15 minutes for quota. Measured on magpie
  0.1.2049 against a control — an ordinary custom provider round-trips the same value 6/6, this one 2/6
  (issue #2). A plugin cannot set it either: the value is dropped in magpie's provider merge, before any
  plugin code runs. The fix has to land in magpie.

---

## Distributing this as a plugin

Pushing the repository to GitHub does not by itself make it show up in Magpie. Per the official docs,
plugins are discovered through three routes, and one is enough:

**1. GitHub topic (least work)**

Tag the repository `magpie-plugin` and it appears under Plugins → Discover → **unofficial plugins**,
sorted by stars and labelled as reviewed by nobody. Requirements:

- `package.json` must be at the **repository root** (satisfied here).
- If the package is also on npm and its `repository` points at this repo, installs come from npm;
  otherwise they install the repository's current code, so **the loaded files must be committed** (this
  repo is pure source with no build output, so this is satisfied).
- Forks, archived repositories, and `magpie-community`'s own repositories are excluded.
- GitHub is polled at most every ten minutes, so a fresh topic shows up within minutes.

**2. npm**

The plugin browser searches npm for `<keyword> opencode`, matching packages whose name or keywords
contain **both** `opencode` and one of auth / plugin / provider. This repository's keywords already
include `opencode`, `opencode-plugin`, and `opencode-auth`, so it qualifies. Ordinary plugins **require
no scope**; `@magpie-community/` is only for packages contributed into the official community repo.

**3. The recommended list (`registry.json`)**

This one is not open to standalone packages. Checked against the live file: all 21 entries are
`@magpie-community/*` and every one carries `"community": true`, with no exception. So being listed means
**becoming a community package** rather than opening a PR that adds an outside package.

To take that route, contribute under `packages/<name>` in `magpie-community/plugins`, naming a provider
package `@magpie-community/opencode-sensenova-auth`, and the entry added looks like the others:

```json
{
  "package": "@magpie-community/opencode-sensenova-auth",
  "name": "SenseNova",
  "icon": "sensenova",
  "providers": ["sensenova"],
  "community": true,
  "summary": {
    "en": "SenseNova Token Plan models, with the console's credit quota reported as native quota windows.",
    "zh": "接入商量/日日新 Token Plan 模型，并把控制台积分额度上报成原生额度窗口。"
  }
}
```

Note `icon` here is a short name (the entries use `opencode`, `zcode`, `qoder`…), not the URL that
`magpie.icon` takes. Two benefits come with it: pushing a version bump to `main` publishes it, and the
package then **auto-updates in every Magpie** instead of users re-installing. This repository has **zero
dependencies**, so moving it there needs no code changes — but it does mean the package is developed inside
someone else's repository, which is why it is not done here by default.

The list is fetched at most every six hours, and Magpie ships a built-in copy as a fallback.
`MAGPIE_PLUGIN_MARKET=<url>` swaps in another list (`off` means use only the built-in copy).

The `repository` / `homepage` / `bugs` fields in `package.json` point at `aqiu817/magpie-sensenova`, and the
repository carries the `magpie-plugin` topic, so it is discoverable through route 1 today. Routes 2 and 3
are opt-in and not done.

---

## Development

```bash
node --test test/*.test.mjs
```

66 tests cover: mapping pools to windows (including the `used` percentage, `amount`, `limit`, `span`,
`resetsAt`, the dedicated pool's model scoping, and the granted balance); that `limit - amount`
reproduces the console balance; that a window with an unknown usage is skipped rather than reported as
zero; degradation when fields are missing; JWT expiry; refresh-token renewal; the error raised when
there are no credentials; the `fetch` hook preserving the body and headers for both `(url, init)` and
`Request` inputs; that internal `__`-prefixed keys never reach the credentials file; both envelopes for
model normalization; locale resolution (explicit, OS, environment, and POSIX `C`); that the two string
tables stay in step; that the shared pool is not run through the dedicated-pool naming rule; that
`accountNameOf` reads the token and yields nothing rather than inventing a name; that the account prompt is
declared under the `email` key and that `consoleAuthOf` still reads the older `username`/`account`
spelling; and the `usage` hook end to end in both languages.
