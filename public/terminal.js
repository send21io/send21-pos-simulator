// The handheld terminal. 💳 card is a SIMULATION ONLY (demo, no real card):
// there are no card fields anywhere and nothing is charged. ⚡ send21 shows one
// pay link QR per sale; ✅ appears only after the server verified the webhook.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const device = $(".device");
  const currency = device.dataset.currency;
  const max = Number(device.dataset.max);
  const fmt = new Intl.NumberFormat("en", { style: "currency", currency });
  const money = (minor) => fmt.format(minor / 100);
  const DEMO = "🧪 demo, no real card";

  // ---------- sound ----------
  let ctx = null;
  let muted = localStorage.getItem("pos-muted") === "1";
  const muteBtn = $("#mute");
  const showMute = () => (muteBtn.textContent = muted ? "sound off" : "sound on");
  showMute();
  muteBtn.addEventListener("click", () => {
    muted = !muted;
    localStorage.setItem("pos-muted", muted ? "1" : "0");
    showMute();
  });
  const beep = (freq = 880, ms = 70, when = 0) => {
    if (muted) return;
    try {
      ctx ??= new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = freq;
      g.gain.value = 0.04;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + when / 1000;
      o.start(t);
      o.stop(t + ms / 1000);
    } catch {
      /* no audio, fine */
    }
  };
  const chime = () => [0, 120, 240].forEach((w, i) => beep([988, 1319, 1760][i], 110, w));
  const buzz = () => [0, 180].forEach((w) => beep(220, 160, w));

  // ---------- state ----------
  let digits = "";
  let tip = 0;
  let screen = "amount";
  let sale = null;
  let extra = null; // { qr, receiptUrl, receiptQr }
  let poll = null;
  let tick = null;
  let busy = false;

  const amount = () => Number(digits || "0");
  const total = () => amount() + Math.round((amount() * tip) / 100);
  const led = (cls) => ($("#led").className = `led ${cls}`);

  function show(name) {
    screen = name;
    for (const el of $$(".scr")) el.hidden = el.dataset.scr !== name;
  }
  function stopTimers() {
    clearInterval(poll);
    clearInterval(tick);
    poll = tick = null;
  }
  function reset() {
    stopTimers();
    digits = "";
    tip = 0;
    sale = extra = null;
    busy = false;
    $("#slip").hidden = true;
    $("#slip").replaceChildren();
    $("#amt").textContent = money(0);
    led("");
    show("amount");
  }

  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) location.reload();
    if (!r.ok) throw new Error(data.error || `error ${r.status}`);
    return data;
  }

  // ---------- screens ----------
  function toTip() {
    if (amount() < 1) return buzz();
    $("#tipBase").textContent = money(amount());
    for (const el of $$("[data-tipamt]")) {
      const t = Number(el.dataset.tipamt);
      el.textContent = t ? `+${money(Math.round((amount() * t) / 100))}` : "";
    }
    for (const b of $$(".tip")) b.classList.toggle("sel", Number(b.dataset.tip) === tip);
    show("tip");
  }
  function toMethod() {
    $("#mTotal").textContent = money(total());
    show("method");
  }

  function done(kind, icon, title, text, opts = {}) {
    stopTimers();
    const box = $('[data-scr="done"]');
    box.className = `scr result ${kind}`;
    $("#doneIcon").textContent = icon;
    $("#doneIcon").classList.remove("pop");
    void $("#doneIcon").offsetWidth;
    $("#doneIcon").classList.add("pop");
    $("#doneTitle").textContent = title;
    $("#doneText").textContent = text;
    $("#doneDemo").hidden = !opts.demo;
    led(kind === "ok" ? "on" : kind === "warn" ? "wait" : "bad");
    show("done");
    if (kind === "ok") chime();
    else buzz();
    if (opts.slip) printSlip();
  }

  function line(left, right, cls = "ln") {
    const p = document.createElement("p");
    p.className = cls;
    const a = document.createElement("span");
    a.textContent = left;
    const b = document.createElement("span");
    b.textContent = right;
    p.append(a, b);
    return p;
  }
  function para(text, cls) {
    const p = document.createElement("p");
    if (cls) p.className = cls;
    p.textContent = text;
    return p;
  }
  function printSlip() {
    const s = sale;
    const slip = $("#slip");
    const card = s.method === "card_sim";
    const when = new Date(s.createdAt);
    const kids = [
      para(document.querySelector(".brand").textContent, "center big"),
      para(`${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "small"),
      para("", "dash"),
      line("sale", money(s.amount)),
      line(`tip ${s.tipPercent}%`, money(s.tip)),
      line("TOTAL", money(s.total), "ln tot"),
      para("", "dash"),
      line("method", card ? "💳 card (simulated)" : "⚡ send21"),
    ];
    if (s.paid) kids.push(line("paid in", `${s.paid.currency} · ${s.paid.network}`));
    kids.push(para(card ? "✅ APPROVED (SIMULATED)" : "✅ PAID", "center tot"));
    if (card) kids.push(para(`${DEMO} · nothing charged`, "center demo-tag"));
    if (extra?.receiptQr) {
      const img = document.createElement("img");
      img.src = extra.receiptQr;
      img.alt = "QR code of the receipt";
      const a = document.createElement("a");
      a.href = extra.receiptUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.append(img);
      kids.push(a, para("📱 scan for your receipt", "small"));
    }
    kids.push(para(`#${s.id}`, "small"), para("thank you 🧡", "small"));
    slip.replaceChildren(...kids);
    slip.hidden = false;
    slip.style.animation = "none";
    void slip.offsetWidth;
    slip.style.animation = "";
    [0, 90, 180, 270, 360].forEach((w) => beep(420, 40, w));
  }

  // 💳 SIMULATED card: a tap animation, then "approved (simulated)". No card data exists here.
  function toTap() {
    $("#tapTotal").textContent = money(total());
    $(".tapzone").classList.remove("tapped");
    $("#tapHint").textContent = "tap the fake card · nothing is charged";
    led("wait");
    show("tap");
  }
  async function tapCard() {
    if (busy || screen !== "tap") return;
    busy = true;
    $(".tapzone").classList.add("tapped");
    $("#tapHint").textContent = "📡 reading… (simulated)";
    beep(1200, 90);
    try {
      const [r] = await Promise.all([api("/api/sales", { amount: amount(), tipPercent: tip, method: "card" }), new Promise((ok) => setTimeout(ok, 1100))]);
      sale = r.sale;
      extra = r;
      done("ok", "✅", "approved (simulated)", `${money(sale.total)} · nothing was charged`, { demo: true, slip: true });
    } catch (err) {
      done("bad", "😵", "error", err.message);
    }
    busy = false;
  }

  // ⚡ send21: one pay link per sale (orderId pos-<saleId> = Idempotency-Key, set on the server)
  async function startSend21() {
    if (busy) return;
    busy = true;
    $("#busyText").textContent = "⚡ creating pay link…";
    show("busy");
    try {
      const r = await api("/api/sales", { amount: amount(), tipPercent: tip, method: "send21" });
      sale = r.sale;
      extra = r;
      $("#qr").src = r.qr;
      $("#qrLink").href = sale.payUrl;
      $("#qrTotal").textContent = money(sale.total);
      $("#qrState").textContent = "⏳ waiting";
      led("wait");
      show("qr");
      beep(660, 80);
      countdown();
      tick = setInterval(countdown, 1000);
      poll = setInterval(refresh, 2000);
    } catch (err) {
      done("bad", "😵", "no pay link", err.message);
    }
    busy = false;
  }
  function countdown() {
    if (!sale?.deadline) return;
    const left = Math.max(0, Math.round((Date.parse(sale.deadline) - Date.now()) / 1000));
    $("#countdown").textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0) refresh();
  }
  async function refresh() {
    if (!sale) return;
    try {
      const { sale: s } = await api(`/api/sales/${sale.id}`);
      sale = s;
      render(s);
    } catch {
      /* keep trying */
    }
  }
  function render(s) {
    switch (s.status) {
      case "open":
        if (screen === "qr") $("#qrState").textContent = "⏳ waiting";
        break;
      case "seen":
        if (screen === "qr") $("#qrState").textContent = "👀 on its way";
        break;
      case "accepted":
        if (screen !== "qr") show("qr");
        $("#qrState").textContent = "👍 accepted · confirming";
        break;
      case "paid":
        done("ok", "✅", "paid", `${money(s.total)} · ${s.paid ? `${s.paid.currency} · ${s.paid.network}` : "send21"}${s.paid?.late ? " · late" : ""}`, { slip: true });
        break;
      case "review":
        if (screen !== "done") {
          done("warn", "⚠️", "amount mismatch", "a different amount arrived · merchant: accept or decline on send21");
          poll = setInterval(refresh, 2000); // keep watching: accepted → paid, or declined
        }
        break;
      case "flagged":
        done("flag", "🚩", "mismatch", "this payment does not match the sale · flagged for the merchant");
        break;
      case "unresolved":
        done("flag", "🚩", "unresolved", "money arrived, nobody decided · flagged for the merchant");
        break;
      case "declined":
        done("bad", "↩️", "declined", "the different amount was declined · start a new sale");
        break;
      case "expired":
        done("bad", "⌛", "expired", "the QR timed out · start a new sale");
        break;
      case "cancelled":
        done("bad", "✖️", "cancelled", "sale cancelled on the terminal");
        break;
    }
  }

  async function cancel() {
    if (sale && sale.method === "send21" && ["open"].includes(sale.status)) {
      try {
        await api(`/api/sales/${sale.id}/cancel`, {});
      } catch {
        /* already moved on */
      }
    }
    beep(330, 90);
    reset();
  }

  // ---------- input ----------
  function press(k) {
    const btn = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
    btn?.classList.add("press");
    setTimeout(() => btn?.classList.remove("press"), 90);
    if (k === "cancel") return void cancel();
    if (screen === "done" && k === "ok") return reset();
    if (screen === "amount") {
      if (/^\d$/.test(k)) {
        const next = (digits + k).replace(/^0+/, "");
        if (Number(next) > max) return buzz();
        digits = next;
        beep(1046, 35);
      } else if (k === "⌫") {
        digits = digits.slice(0, -1);
        beep(700, 35);
      } else if (k === "C") {
        digits = "";
        beep(500, 50);
      } else if (k === "ok") {
        beep(1318, 60);
        return toTip();
      }
      $("#amt").textContent = money(amount());
      return;
    }
    if (screen === "tip" && k === "ok") return toMethod();
    if (screen === "tap" && k === "ok") return void tapCard();
    if (k === "C" || k === "⌫") {
      if (screen === "tip") return show("amount");
      if (screen === "method") return toTip();
    }
  }
  for (const b of $$("[data-key]")) b.addEventListener("click", () => press(b.dataset.key));
  for (const b of $$(".tip"))
    b.addEventListener("click", () => {
      tip = Number(b.dataset.tip);
      beep(1175, 50);
      toMethod();
    });
  for (const b of $$(".pick"))
    b.addEventListener("click", () => {
      beep(1175, 50);
      if (b.dataset.method === "card") toTap();
      else void startSend21();
    });
  $(".tapzone").addEventListener("click", () => void tapCard());
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const map = { Enter: "ok", Backspace: "⌫", Escape: "cancel", Delete: "C" };
    const k = /^\d$/.test(e.key) ? e.key : map[e.key];
    if (k) {
      e.preventDefault();
      press(k);
    }
  });

  // ---------- merchant panel ----------
  const li = (cls, ...kids) => {
    const el = document.createElement("li");
    el.className = cls;
    el.append(...kids);
    return el;
  };
  const span = (text, cls) => {
    const el = document.createElement("span");
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
  };
  const ICON = { approved_sim: "💳", open: "⏳", seen: "👀", review: "⚠️", accepted: "👍", paid: "✅", declined: "↩️", unresolved: "🚩", expired: "⌛", flagged: "🚩", cancelled: "✖️" };
  const LABEL = { approved_sim: "card (sim)", paid: "send21 paid" };
  async function panel() {
    try {
      const s = await api("/api/summary");
      const f = new Intl.NumberFormat("en", { style: "currency", currency: s.currency });
      const m = (x) => f.format(x / 100);
      $("#sCard").textContent = `${m(s.cardSim.total)} · ${s.cardSim.count}`;
      $("#sS21").textContent = `${m(s.send21.total)} · ${s.send21.count}`;
      $("#sTips").textContent = m(s.send21.tips);
      $("#sRev").textContent = String(s.review.length);
      $("#sRevBox").className = s.review.length ? "warn" : "";
      const rev = s.review.map((x) => {
        const d = document.createElement("div");
        const b = document.createElement("b");
        b.textContent = `${ICON[x.status] ?? "•"} ${m(x.total)} `;
        const ul = document.createElement("ul");
        ul.className = "problems";
        for (const p of x.problems) {
          const i = document.createElement("li");
          i.textContent = p;
          ul.append(i);
        }
        d.append(b, span(`#${x.id} · ${x.status}`, "sub"), ul);
        return li("row flag", d);
      });
      $("#review").replaceChildren(...(rev.length ? rev : [li("row small", "nothing to review 🎉")]));
      const recent = s.recent.map((x) => {
        const d = document.createElement("div");
        const b = document.createElement("b");
        b.textContent = m(x.total);
        d.append(b, span(` · ${LABEL[x.status] ?? x.status}${x.tip ? ` · 💝 ${x.tipPercent}%` : ""}${x.paid ? ` · ${x.paid.currency}` : ""}`, "sub"));
        if (x.method === "card_sim") d.append(span("demo", "tag"));
        const t = document.createElement("time");
        t.textContent = new Date(x.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return li("row", span(ICON[x.status] ?? "•", "ic"), d, t);
      });
      $("#recent").replaceChildren(...(recent.length ? recent : [li("row small", "no sales yet")]));
    } catch {
      /* next round */
    }
  }
  panel();
  setInterval(panel, 3000);
  reset();
})();
