import { coinFor, formatFiat } from "./currencies.js";
import { toMajor } from "./pos.js";
import type { PayOption, Sale } from "./types.js";

// Server-rendered pages. Every dynamic value goes through esc(). No inline
// script or style (CSP 'self'): the terminal runs from /terminal.js.

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const money = (minor: number, currency: string) => formatFiat(toMajor(minor, currency), currency);

export const DEMO = "🧪 demo, no real card";

export function layout(title: string, body: string, opts: { script?: string; mock?: boolean; cls?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/pos.css">${opts.script ? `<script src="${esc(opts.script)}" defer></script>` : ""}</head>
<body${opts.cls ? ` class="${esc(opts.cls)}"` : ""}><main class="wrap">${body}</main>
<footer class="foot">💳 card = ${DEMO} · ${opts.mock ? "🧪 mock send21 · no real money · " : ""}🔒 non-custodial · crypto by <a href="https://send21.io">send21</a></footer></body></html>`;
}

const chips = (options: PayOption[]) =>
  [...new Map(options.map((o) => { const c = coinFor(o.currency, o.network, o.method); return [c?.id ?? o.currency, c] as const; })).values()]
    .map((c) => (c ? `<li>${c.emoji} ${esc(c.label)}</li>` : ""))
    .join("");

/** The handheld terminal and, next to it, the merchant panel. The screens are filled by /terminal.js. */
export function terminalPage(o: { shop: string; currency: string; options: PayOption[]; maxAmount: number; mock: boolean }): string {
  const key = (k: string, label = k, cls = "") => `<button type="button" class="key ${cls}" data-key="${esc(k)}">${label}</button>`;
  return layout(
    `${o.shop} · terminal`,
    `<div class="desk">
<section class="device" aria-label="payment terminal" data-currency="${esc(o.currency)}" data-max="${o.maxAmount}" data-mock="${o.mock ? 1 : 0}">
<div class="bezel">
<div class="top"><span class="led" id="led"></span><span class="brand">${esc(o.shop)}</span><span class="nfc" aria-hidden="true">)))</span></div>
<div class="screen" id="screen" aria-live="polite">
<div class="scr" data-scr="amount">
<p class="lbl">🧾 new sale</p><p class="amt" id="amt">${esc(money(0, o.currency))}</p><p class="hint">type the amount · ✅ OK</p></div>
<div class="scr" data-scr="tip" hidden>
<p class="lbl">💝 add a tip?</p><p class="amt sm" id="tipBase"></p>
<div class="tips">${[0, 10, 15, 20].map((t) => `<button type="button" class="tip" data-tip="${t}">${t ? `${t}%` : "no tip"}<small data-tipamt="${t}"></small></button>`).join("")}</div></div>
<div class="scr" data-scr="method" hidden>
<p class="lbl">👇 how do you pay?</p><p class="amt" id="mTotal"></p>
<button type="button" class="pick card" data-method="card">💳 Card <small>${DEMO}</small></button>
<button type="button" class="pick s21" data-method="send21">⚡ send21 <small>crypto · scan a QR</small></button></div>
<div class="scr" data-scr="tap" hidden>
<p class="demo-tag">${DEMO}</p><p class="amt sm" id="tapTotal"></p>
<div class="tapzone"><span class="wave w1"></span><span class="wave w2"></span><span class="wave w3"></span><span class="fakecard">💳</span></div>
<p class="hint" id="tapHint">tap the fake card · nothing is charged</p></div>
<div class="scr" data-scr="qr" hidden>
<p class="lbl">⚡ scan to pay</p><p class="amt sm" id="qrTotal"></p>
<a id="qrLink" class="qrlink" target="_blank" rel="noopener noreferrer"><img id="qr" class="qr" alt="QR code of the send21 pay link" width="148" height="148"></a>
<p class="count"><span id="countdown">--:--</span> <span id="qrState">⏳ waiting</span></p>
<ul class="coins">${chips(o.options)}</ul></div>
<div class="scr" data-scr="busy" hidden><p class="huge spin">⏳</p><p class="hint" id="busyText">creating pay link…</p></div>
<div class="scr result" data-scr="done" hidden>
<p class="huge pop" id="doneIcon">✅</p><p class="big" id="doneTitle"></p><p class="hint" id="doneText"></p><p class="demo-tag" id="doneDemo" hidden>${DEMO}</p></div>
<p class="screen-foot">💳 card = ${DEMO}</p>
</div>
<div class="keys" id="keys">
${["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => key(k)).join("")}
${key("C", "C", "red")}${key("0")}${key("⌫", "⌫", "yellow")}
</div>
<div class="row3">${key("cancel", "✖️ cancel", "red wide")}${key("ok", "✅ OK", "green wide")}</div>
</div>
<div class="printer"><div class="slip" id="slip" hidden></div></div>
<p class="small center">${o.mock ? "🧪 mock: tap the QR to open the fake wallet" : "📱 customer scans the QR with any wallet"} · 🔊 <button type="button" class="linkbtn" id="mute">sound on</button></p>
</section>
<aside class="panel" aria-label="merchant panel" id="panel">
<p class="kicker">🔐 merchant · today</p>
<ul class="stats"><li><b id="sCard">–</b><span>💳 card (sim)</span></li><li><b id="sS21">–</b><span>⚡ send21</span></li><li><b id="sTips">–</b><span>💝 send21 tips</span></li><li id="sRevBox"><b id="sRev">0</b><span>🚩 to review</span></li></ul>
<p class="small">💳 card totals = ${DEMO} · never real money</p>
<h2>🚩 Review</h2><ul class="list" id="review"><li class="row small">nothing to review 🎉</li></ul>
<h2>🧾 Today</h2><ul class="list" id="recent"><li class="row small">no sales yet</li></ul>
<p class="small"><a href="/logout">log out</a></p>
</aside>
</div>`,
    { script: "/terminal.js", mock: o.mock, cls: "pos" },
  );
}

export function loginPage(mock: boolean, error?: string): string {
  return layout(
    "terminal login",
    `<article class="card center"><p class="huge">🔐</p><h1>Terminal</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login" class="stack"><input type="password" name="token" placeholder="MERCHANT_TOKEN" aria-label="token" autocomplete="current-password" required><button class="cta">Open</button></form>
${mock ? `<p class="small"><a href="/demo">🧪 one-click demo login</a></p>` : ""}</article>`,
    { mock },
  );
}

const coinLabel = (p: { currency: string; network: string }) => coinFor(p.currency, p.network)?.label ?? `${p.currency} · ${p.network}`;

/** The receipt behind the QR on the paper slip. */
export function receiptPage(s: Sale, shop: string, mock: boolean): string {
  const card = s.method === "card_sim";
  const ok = card || s.status === "paid";
  return layout(
    `receipt · ${shop}`,
    `<article class="slip big-slip">
<p class="center"><b>${esc(shop)}</b></p><p class="center small">${esc(s.createdAt.slice(0, 16).replace("T", " "))} UTC</p>
<p class="dash"></p>
<p class="ln"><span>sale</span><span>${esc(money(s.amount, s.currency))}</span></p>
<p class="ln"><span>tip ${s.tipPercent}%</span><span>${esc(money(s.tip, s.currency))}</span></p>
<p class="ln tot"><span>TOTAL</span><span>${esc(money(s.total, s.currency))}</span></p>
<p class="dash"></p>
<p class="ln"><span>method</span><span>${card ? "💳 card (simulated)" : "⚡ send21"}</span></p>
${s.paid ? `<p class="ln"><span>paid in</span><span>${esc(coinLabel(s.paid))}</span></p>` : ""}
<p class="center big">${ok ? (card ? "✅ APPROVED (SIMULATED)" : "✅ PAID") : `• ${esc(s.status)}`}</p>
${card ? `<p class="center demo-tag">${DEMO} · nothing was charged</p>` : ""}
<p class="center small">#${esc(s.id)}</p><p class="dash"></p><p class="center small">thank you 🧡</p></article>`,
    { mock },
  );
}

export function mockPayPage(entry: { fiatAmount: number; fiatCurrency: string; memo: string; options: PayOption[] }, token: string): string {
  const t = esc(token);
  const coins = entry.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
  const actions = [
    ["seen", "👀 start paying"],
    ["paid", "✅ pay"],
    ["short", "⚠️ pay 5% short"],
    ["reject", "↩️ merchant declines the short pay"],
    ["wrong", "🚩 pay a wrong coin"],
    ["expire", "⌛ let it expire"],
  ];
  return layout(
    "mock pay · send21",
    `<article class="card center"><p class="pill">🧪 mock send21 · no real money</p><p class="price">${esc(formatFiat(entry.fiatAmount, entry.fiatCurrency))}</p><p class="small">${esc(entry.memo)}</p>
${actions.map(([a, l]) => `<form class="mockrow" method="post" action="/mock/pay/${t}/${a}"><select name="coin" aria-label="coin">${coins}</select><button>${l}</button></form>`).join("")}
<p class="small">↩️ then look at the terminal</p></article>`,
    { mock: true },
  );
}

export function errorPage(msg: string, mock: boolean): string {
  return layout("oops", `<article class="card center"><p class="huge">😵</p><p>${esc(msg)}</p><a class="cta ghost" href="/">↩️ back</a></article>`, { mock });
}
