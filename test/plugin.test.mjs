import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SenseNovaPlugin } from "../index.mjs";

/**
 * Run one request through the plugin's `fetch` hook and report what the host's
 * `fetch` actually received. The hook re-reads the sign-in per request, so the
 * stub has to be in place before the call, not before the loader.
 */
async function through(key, input, init) {
  const plugin = await SenseNovaPlugin({}, {});
  const { fetch: wrapped } = await plugin.auth.loader(async () => ({ type: "api", key }));

  const real = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (a, b) => {
    const req = a instanceof Request ? a : null;
    const headers = req ? req.headers : new Headers(b?.headers);
    seen = {
      isRequest: req !== null,
      url: req ? req.url : a,
      method: req ? req.method : b?.method,
      authorization: headers.get("authorization"),
      trace: headers.get("x-trace"),
      body: req ? await req.text() : typeof b?.body === "string" ? b.body : undefined,
    };
    return new Response("{}", { status: 200 });
  };
  try {
    await wrapped(input, init);
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

const BODY = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
const URL_ = "https://token.sensenova.cn/v1/chat/completions";

test("(url, init) 调用：带上 authorization，body 原样透传", async () => {
  const seen = await through("sk-test", URL_, { method: "POST", body: BODY });
  assert.equal(seen.url, URL_);
  assert.equal(seen.method, "POST");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY);
});

test("Request 调用：不能因为改头就把 body 丢掉", async () => {
  // 回归：早先的实现用 `request.url` 重新发起，{...init} 在没有 init 时是空对象，
  // 于是 POST 的 body 静默消失，只剩一个空请求。
  const seen = await through("sk-test", new Request(URL_, { method: "POST", body: BODY }));
  assert.equal(seen.url, URL_);
  assert.equal(seen.method, "POST", "method 必须保留");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY, "body 必须保留");
});

test("Request 调用：保留原请求自己的头", async () => {
  // 断言的是发出去的头，不是转发形状——Request 和 (url, init) 两种形态都该成立。
  const seen = await through("sk-test", new Request(URL_, { method: "POST", body: BODY, headers: { "x-trace": "abc" } }));
  assert.equal(seen.trace, "abc");
  assert.equal(seen.authorization, "Bearer sk-test");
  assert.equal(seen.body, BODY);
});

test("没有 key 时删掉 authorization，而不是留着上一个账号的", async () => {
  const seen = await through(undefined, URL_, {
    method: "POST",
    body: BODY,
    headers: { authorization: "Bearer stale" },
  });
  assert.equal(seen.authorization, null);
  assert.equal(seen.body, BODY);
});

/** The pool-usage response, abbreviated to what the mapping reads. */
const POOL_USAGE = {
  plan: { name: "Free Plan" },
  pools: [
    {
      name: "通用积分池",
      pool_type: "default",
      window_5h: { remaining: "60000", limit: "60000", reset_at: 1791983400 },
      window_7d: { remaining: "591017.32584", limit: "600000", reset_at: 1792000200 },
      grant_balance: "1292155358",
    },
    {
      name: "Flash-Lite积分池",
      pool_type: "dedicated",
      model_ids: ["sensenova-6.8-flash-lite"],
      window_5h: { remaining: "40967.482", limit: "60000", reset_at: 1791983400 },
    },
  ],
};

/** Temp credential files created by `usageWith`, removed when the file exits. */
const TEMP_DIRS = [];
process.on("exit", () => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** A JWT whose payload decodes, just enough to carry a claim. */
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

/**
 * Run the `usage` hook against a stubbed quota endpoint, with the credentials
 * file pointed at a temp path so the test never reads or writes the real one.
 */
async function usageWith(options, auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensenova-"));
  TEMP_DIRS.push(dir);
  const file = path.join(dir, "quota.json");
  // `auth.file` seeds the whole payload (for slot layouts); otherwise it is the
  // single-account record vector the CLI writes.
  fs.writeFileSync(
    file,
    JSON.stringify(
      auth.file ?? {
        base: "https://platform.sensenova.cn",
        access_token: auth.token,
        expires_at: 4102444800,
      }
    )
  );

  const plugin = await SenseNovaPlugin({}, { ...options, credentialsFile: file });
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_input, init) => {
    // The token actually used is the evidence for "did the rows stay apart".
    sent.push(new Headers(init?.headers).get("authorization"));
    return new Response(JSON.stringify(POOL_USAGE), { status: 200 });
  };
  try {
    const usage = await plugin.auth.usage(async () => ({ type: "api", key: auth.key ?? "sk-test", metadata: auth.metadata }));
    return Object.assign(usage, { __sent: sent, __file: file });
  } finally {
    globalThis.fetch = real;
  }
}

test("locale: en 让窗口标签、单位和余额都变英文", async () => {
  const usage = await usageWith({ locale: "en" }, { token: "opaque" });
  assert.equal(usage.plan, "Free Plan");
  assert.equal(usage.balance, "1,292,155,358 credits");
  assert.deepEqual(
    usage.windows.map((w) => w.name),
    ["General Pool · 5h window", "General Pool · This week", "Flash-Lite Dedicated Pool · 5h window"]
  );
  assert.equal(usage.windows[0].unit, "credits");
});

test("locale: zh 保持原样", async () => {
  const usage = await usageWith({ locale: "zh" }, { token: "opaque" });
  assert.equal(usage.balance, "1,292,155,358 积分");
  assert.deepEqual(
    usage.windows.map((w) => w.name),
    ["通用积分池 · 5 小时窗口", "通用积分池 · 本周", "Flash-Lite积分池 · 5 小时窗口"]
  );
});

test("账号行优先用 token 里的账号名，而不是登录时填的账号", async () => {
  // 只填 API Key 时用户拿不到名字；token 里带着它，所以账号行不必显示 API Key。
  // token 放在该账号自己的槽位里：登录名 138… 与令牌里的 Ada 不是同一个名字，
  // 顶层记录在这种不一致下不会被借用（见下面「不借用别人的令牌」）。
  const usage = await usageWith({ locale: "en" }, {
    file: {
      base: "https://platform.sensenova.cn",
      accounts: {
        "13800000000": { access_token: jwt({ ext: { username: "Ada" } }), expires_at: 4102444800 },
      },
    },
    metadata: { username: "13800000000" },
  });
  assert.equal(usage.user, "Ada");
  assert.equal(usage.__sent[0], `Bearer ${jwt({ ext: { username: "Ada" } })}`, "用的是自己槽位里的令牌");
});

test("两个账号各用自己的令牌，不会读到同一份", async () => {
  // 多账号串台是这个 bug 的原始症状：以前顶层只有一份令牌，所有账号行都读它，
  // 于是最后登录的账号赢，其余行显示同一份额度。
  const a = jwt({ ext: { username: "acctA" } });
  const b = jwt({ ext: { username: "acctB" } });
  const file = {
    base: "https://platform.sensenova.cn",
    // 顶层还有一份（CLI 写的那份）。以前所有账号行都读它，这正是串台的原因，
    // 所以夹具必须带上它，否则这个测试证明不了任何事。
    access_token: a,
    expires_at: 4102444800,
    accounts: {
      acctA: { access_token: a, expires_at: 4102444800 },
      acctB: { access_token: b, expires_at: 4102444800 },
    },
  };
  const rowA = await usageWith({ locale: "en" }, { file, metadata: { email: "acctA" } });
  const rowB = await usageWith({ locale: "en" }, { file, metadata: { email: "acctB" } });
  assert.equal(rowA.__sent[0], `Bearer ${a}`);
  assert.equal(rowB.__sent[0], `Bearer ${b}`);
  assert.notEqual(rowA.__sent[0], rowB.__sent[0], "两行必须用不同的令牌");
});

test("不借用别人账号的顶层令牌", async () => {
  // 顶层记录属于 Ada；登录成另一个账号时不该拿它去读额度。
  const usage = await usageWith({ locale: "en" }, {
    token: jwt({ ext: { username: "Ada" } }),
    metadata: { email: "someone-else" },
  });
  assert.equal(usage.__sent.length, 0, "不应发出任何请求");
  assert.match(String(usage.error), /account/i);
});

test("没填账号时沿用顶层令牌里的账号名，保住单账号的老用法", async () => {
  // 「留空则读 snquota 存的那份」必须继续可用：此时采用令牌自带的账号名作槽位。
  const token = jwt({ ext: { username: "Ada" } });
  const usage = await usageWith({ locale: "en" }, { token });
  assert.equal(usage.__sent[0], `Bearer ${token}`);
  assert.equal(usage.user, "Ada");
});

test("token 里没有名字时退回登录时填的账号", async () => {
  const usage = await usageWith({ locale: "en" }, {
    token: "opaque",
    metadata: { username: "13800000000" },
  });
  assert.equal(usage.user, "13800000000");
});

test("两者都没有时不设 user，交给 Magpie 退回显示 API Key", async () => {
  const usage = await usageWith({ locale: "en" }, { token: "opaque" });
  assert.equal("user" in usage, false);
});

test("不能再声明 key 提示：Magpie 对 api 方法自己就会问一次 key", async () => {
  // 用户反馈的真实缺陷：以前 prompts 里同时有 key 和 Magpie 自带的那个，
  // 同一个密钥被问两遍。实测印证过——按 prompts 数量喂管道输入会不够用，
  // 总要多喂一行。社区插件（zcode 的 api 方法）也只声明自己的额外字段。
  const plugin = await SenseNovaPlugin({}, {});
  const keys = plugin.auth.methods[0].prompts.map((p) => p.key);
  assert.equal(keys.includes("key"), false, "key 提示会和 Magpie 自带的重复");
  assert.deepEqual(keys, ["email", "password"]);
});

test("账号提问的 key 必须是 email，否则账号行只显示 API Key", async () => {
  // Magpie 依次用 accountId、metadata.email、email 给账号命名，而提示的 key
  // 决定答案落进 metadata 的哪个字段。实测：api 类型下 authorize 返回的
  // accountId 与 metadata 都不起作用（前者被忽略，后者被提示答案覆盖），
  // 只有把提示字段命名为 email 才真的改到账号行；改回去就退化成「API key …尾4位」。
  const plugin = await SenseNovaPlugin({}, {});
  assert.equal(plugin.auth.methods[0].prompts[0].key, "email");
});

test("api 方法把 key 的提示交给 Magpie：用 placeholder 而不是自定义提示", async () => {
  const plugin = await SenseNovaPlugin({}, {});
  const method = plugin.auth.methods[0];
  assert.equal(method.type, "api");
  assert.equal(method.placeholder, "sk-…");
  // 不再自带 authorize：密钥由 Magpie 收集并校验（空 key 报的是它的错）。
  assert.equal(method.authorize, undefined);
});

test("提示都带本地化后的文案，方法标签也是", async () => {
  const en = await SenseNovaPlugin({}, { locale: "en" });
  const method = en.auth.methods[0];
  assert.match(method.label, /API-Key management/i, "方法标签要说明去哪找 key");
  for (const p of method.prompts) {
    assert.ok(typeof p.message === "string" && p.message.length > 0, `${p.key} 缺 message`);
  }
  assert.match(method.prompts[0].message, /Optional/, "英文表应生效");
});

test("consoleAuthOf 认 email，也兼容旧的 username / account", async () => {
  const { consoleAuthOf } = await import("../internal.mjs");
  assert.equal(consoleAuthOf({ metadata: { email: "ada@example.com" } }).username, "ada@example.com");
  // 改名前登录的账号存在 username 下，不能因为改名就丢掉那套控制台凭据。
  assert.equal(consoleAuthOf({ metadata: { username: "旧账号" } }).username, "旧账号");
  assert.equal(consoleAuthOf({ metadata: { account: "别名" } }).username, "别名");
  // email 优先，且去空白
  assert.equal(
    consoleAuthOf({ metadata: { email: "  new@x.com  ", username: "old" } }).username,
    "new@x.com"
  );
  assert.equal(consoleAuthOf({ metadata: { email: "   " } }).username, undefined);
  assert.equal(consoleAuthOf(undefined).username, undefined);
});

test("老文件（无槽位）下，顶层令牌只借给账号名对得上的那一行", async () => {
  // 这就是原始 bug 的最小场景：文件里只有一份令牌，两条账号行都想读它。
  // 以前两条都读，于是都显示同一个账号的额度。
  const token = jwt({ ext: { username: "acctA" } });
  const matching = await usageWith({ locale: "en" }, { token, metadata: { email: "acctA" } });
  assert.equal(matching.__sent[0], `Bearer ${token}`, "同名账号应当借用");

  const stranger = await usageWith({ locale: "en" }, { token, metadata: { email: "acctB" } });
  assert.equal(stranger.__sent.length, 0, "另一个账号不该读到这份令牌");
  assert.match(String(stranger.error), /account/i);
});
