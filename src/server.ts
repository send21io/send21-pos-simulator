import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response } from "express";
import QRCode from "qrcode";
import { errorPage, loginPage, mockPayPage, receiptPage, terminalPage } from "./pages.js";
import { keyOk, publicSale, type Pos } from "./pos.js";
import { friendlyError, type createMockClient } from "./send21.js";
import { Store } from "./store.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  pos: Pos;
  secret: string;
  merchantToken: string;
  publicUrl: string;
  log?: (line: string) => void;
  mockSend21?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  trustProxy?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SALE = /^[a-z0-9]{12}$/;
const SESSION_MS = 12 * 3600_000;
const COOKIE = "s21_pos";

const qrSvg = async (text: string, width = 168) =>
  `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(text, { type: "svg", margin: 1, width, color: { dark: "#121317", light: "#ffffff" } })).toString("base64")}`;

export function rateLimit(burst: number, everyMs: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (now - b.at) / everyMs);
    b.at = now;
    if (b.tokens < 1) {
      res.set("Retry-After", String(Math.ceil(everyMs / 1000))).status(429).json({ error: "🐢 slow down, try again in a minute" });
      return;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    if (buckets.size > 10_000) buckets.clear();
    next();
  };
}

const noStore = (res: Response) => res.set("Cache-Control", "no-store");

export function createApp(deps: AppDeps): Express {
  const { pos, secret, merchantToken, publicUrl, log = console.log, mockSend21, trustProxy = false } = deps;
  const mock = !!mockSend21;
  const { store } = pos;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, send21: mock ? "mock" : "live", card: "simulated" });
  });

  // ---------- send21 webhook ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied: ReturnType<Pos["applyEvent"]> | null;
    try {
      applied = store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? pos.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
  });

  // ---------- merchant session (terminal + panel) ----------
  const key = createHmac("sha256", merchantToken).update("pos-session").digest();
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
  const session = () => {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  };
  const authed = (req: Request) => {
    const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.get("cookie") ?? "")?.[1] ?? "";
    const [exp, sig] = raw.split(".");
    if (!exp || !sig || !/^\d{13}$/.test(exp) || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const secure = publicUrl.startsWith("https://");
  const setSession = (res: Response) => res.cookie(COOKIE, session(), { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: SESSION_MS });
  const sameSite = (req: Request) => {
    const site = req.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return false;
    // Treat a missing Origin, or the opaque "null" string, as OK: Sec-Fetch-Site already
    // blocks cross-site. Some browsers (and Playwright) send Origin: null on same-origin POSTs.
    const origin = req.get("origin");
    if (!origin || origin === "null") return true;
    return origin === new URL(publicUrl).origin || origin === `${req.protocol}://${req.get("host")}`;
  };
  const tokenEq = (got: unknown) => timingSafeEqual(createHmac("sha256", key).update(String(got ?? "")).digest(), createHmac("sha256", key).update(merchantToken).digest());
  /** API guard: logged-in merchant, and POSTs only from our own pages. */
  const guard = (req: Request, res: Response) => {
    if (!authed(req)) {
      noStore(res).status(401).json({ error: "🔐 log in again" });
      return false;
    }
    if (req.method !== "GET" && !sameSite(req)) {
      res.status(403).json({ error: "cross-site" });
      return false;
    }
    return true;
  };

  app.get("/", (req, res) => {
    noStore(res)
      .type("html")
      .send(authed(req) ? terminalPage({ shop: pos.cfg.shop, currency: pos.cfg.currency, options: pos.cfg.options, maxAmount: pos.cfg.maxAmount, mock }) : loginPage(mock));
  });
  app.post("/login", rateLimit(5, 60_000), express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
    if (!sameSite(req) || !tokenEq((req.body as { token?: unknown })?.token)) {
      res.status(401).type("html").send(loginPage(mock, "🙅 wrong token"));
      return;
    }
    setSession(res);
    res.redirect(303, "/");
  });
  if (mock) {
    app.get("/demo", (_req, res) => {
      setSession(res);
      res.redirect(303, "/");
    });
  }
  app.get("/logout", (_req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.redirect(303, "/");
  });

  // ---------- terminal API ----------
  const json = express.json({ limit: "1kb" });
  const sweep = () => store.transaction((d) => pos.sweep(d));

  app.post("/api/sales", rateLimit(30, 60_000), json, async (req, res) => {
    if (!guard(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const r = await pos.start({ amount: body.amount, tipPercent: body.tipPercent, method: body.method });
      if (!r.ok) {
        res.status(r.status ?? 400).json({ error: r.error });
        return;
      }
      const receiptUrl = `${publicUrl}/r/${r.sale.id}/${r.receiptKey}`;
      log(`sale ${r.sale.id} ${r.sale.method} ${r.sale.total} ${r.sale.currency}${r.sale.method === "card_sim" ? " (SIMULATED card, nothing charged)" : ""}`);
      noStore(res).json({
        sale: publicSale(r.sale),
        qr: r.sale.payUrl ? await qrSvg(r.sale.payUrl) : null,
        receiptUrl,
        receiptQr: await qrSvg(receiptUrl, 96),
      });
    } catch (err) {
      log(`pay link failed: ${(err as Error).message}`);
      res.status(502).json({ error: friendlyError(err) });
    }
  });
  app.get("/api/sales/:id", (req, res) => {
    if (!guard(req, res)) return;
    const id = String(req.params.id);
    sweep();
    const s = SALE.test(id) ? store.get(id) : undefined;
    if (!s) {
      res.status(404).json({ error: "unknown sale" });
      return;
    }
    noStore(res).json({ sale: publicSale(s) });
  });
  app.post("/api/sales/:id/cancel", json, (req, res) => {
    if (!guard(req, res)) return;
    const r = pos.cancel(String(req.params.id));
    if (!r.ok) {
      res.status(r.status ?? 400).json({ error: r.error });
      return;
    }
    noStore(res).json({ sale: publicSale(r.sale) });
  });
  app.get("/api/summary", (req, res) => {
    if (!guard(req, res)) return;
    sweep();
    noStore(res).json(pos.summary());
  });

  // ---------- receipt (QR on the slip) ----------
  app.get("/r/:id/:key", (req, res) => {
    const id = String(req.params.id);
    const s = SALE.test(id) ? store.get(id) : undefined;
    if (!s || !keyOk(String(req.params.key), s.receiptHash)) {
      noStore(res).status(404).type("html").send(errorPage("🤷 unknown receipt", mock));
      return;
    }
    noStore(res).type("html").send(receiptPage(s, pos.cfg.shop, mock));
  });

  if (mockSend21) mountMockPay(app, secret, mockSend21);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  return app;
}

// ---------- mock send21 ----------

function mountMockPay(app: Express, secret: string, mock: NonNullable<AppDeps["mockSend21"]>): void {
  const { client } = mock;
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)));
  });
  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(String(req.params.token));
    if (!entry) {
      res.status(404).type("html").send(errorPage("🤷 unknown pay link", true));
      return;
    }
    const body = mockEvent(entry, Number((req.body as { coin?: string })?.coin ?? 0), String(req.params.action));
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
      body: raw,
    });
    res.type("html").send(mockPayPage(entry.body, String(req.params.token)).replace('<p class="small">↩️', `<p class="pill">${r.ok ? "📨 sent" : "❌"} ${body.event}</p><p class="small">↩️`));
  });
}

type MockEntry = NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>;

export function mockEvent(entry: MockEntry, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const base = {
    draftId: randomUUID(),
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  const confirmed = { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } };
  switch (action) {
    case "paid":
      return confirmed;
    case "wrong":
      return { ...confirmed, data: { ...confirmed.data, sentCurrency: "ETH", network: "Arbitrum" } };
    case "seen":
      return { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } };
    case "short":
      return { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } };
    case "reject":
      return { event: "draft.mismatch_rejected", data: { ...base, status: "AwaitingPayment", reviewState: "rejected", receivedAmountSats: Math.round(amountSats * 0.95) } };
    default:
      return { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
  }
}
