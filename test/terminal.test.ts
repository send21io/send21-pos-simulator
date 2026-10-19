import { describe, expect, it } from "vitest";
import { world } from "./helpers.js";

describe("terminal + merchant panel over HTTP", () => {
  it("needs a merchant session; POSTs only from our own pages", async () => {
    const w = await world();
    expect(await (await fetch(`${w.url}/`)).text()).toContain("MERCHANT_TOKEN");
    expect((await fetch(`${w.url}/api/summary`)).status).toBe(401);
    expect((await fetch(`${w.url}/api/sales`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await w.api("/api/sales", { amount: 100, tipPercent: 0, method: "card" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await w.api("/api/sales", { amount: 100, tipPercent: 0, method: "card" }, { origin: "https://evil.example" })).status).toBe(403);
    const bad = await fetch(`${w.url}/login`, { method: "POST", body: new URLSearchParams({ token: "nope-nope-nope-nope-nope-nope" }) });
    expect(bad.status).toBe(401);
    const page = await (await w.get("/")).text();
    expect(page).toContain('id="keys"');
    await w.close();
  });

  it("💳 says 'demo, no real card' everywhere and has no card data fields", async () => {
    const w = await world();
    const page = await (await w.get("/")).text();
    expect(page.match(/demo, no real card/g)!.length).toBeGreaterThanOrEqual(3);
    expect(page).not.toMatch(/<input|<select|<textarea/i);
    expect(page).not.toMatch(/card number|cvv|cvc|expiry date|\bpan\b/i);
    const s = await w.sell(450, 10, "card");
    expect(s.sale).toMatchObject({ method: "card_sim", status: "approved_sim", total: 495, payUrl: null });
    expect(s.qr).toBeNull();
    const receipt = await (await fetch(s.receiptUrl.replace(w.cfg.publicUrl, w.url))).text();
    expect(receipt).toContain("APPROVED (SIMULATED)");
    expect(receipt).toContain("demo, no real card");
    expect(w.logs.join("\n")).toContain("SIMULATED card");
    await w.close();
  });

  it("⚡ full loop on mock send21: QR → wallet pays → signed webhook → ✅ paid + receipt", async () => {
    const w = await world();
    const s = await w.sell(1200, 20, "send21");
    expect(s.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(s.sale.payUrl).toMatch(/\/mock\/pay\//);
    const token = s.sale.payUrl!.split("/").pop()!;
    const wallet = await (await fetch(`${w.url}/mock/pay/${token}`)).text();
    expect(wallet).toContain("€14.40");
    await fetch(`${w.url}/mock/pay/${token}/paid`, { method: "POST", body: new URLSearchParams({ coin: "1" }) });
    const status = (await (await w.get(`/api/sales/${s.id}`)).json()) as { sale: { status: string; paid: { currency: string } } };
    expect(status.sale.status).toBe("paid");
    expect(status.sale.paid.currency).toBe("USDC");
    expect(JSON.stringify(status)).not.toMatch(/receiptHash|address/);
    const receipt = await (await fetch(s.receiptUrl.replace(w.cfg.publicUrl, w.url))).text();
    expect(receipt).toContain("✅ PAID");
    expect(receipt).toContain("€14.40");
    expect((await fetch(`${w.url}/r/${s.id}/${"A".repeat(43)}`)).status).toBe(404);
    await w.close();
  });

  it("mock wallet: wrong coin → 🚩 flagged; short + decline → ↩️ declined; expire → ⌛", async () => {
    const w = await world();
    const pay = async (action: string) => {
      const s = await w.sell(800, 0, "send21");
      const token = s.sale.payUrl!.split("/").pop()!;
      if (action === "decline") {
        await fetch(`${w.url}/mock/pay/${token}/short`, { method: "POST", body: new URLSearchParams({ coin: "1" }) });
        expect(s.stored().status).toBe("review");
        action = "reject";
      }
      await fetch(`${w.url}/mock/pay/${token}/${action}`, { method: "POST", body: new URLSearchParams({ coin: "1" }) });
      return s.stored().status;
    };
    expect(await pay("wrong")).toBe("flagged");
    expect(await pay("decline")).toBe("declined");
    expect(await pay("expire")).toBe("expired");
    await w.close();
  });

  it("panel: today's totals split card (sim) / send21, tips, review list", async () => {
    const w = await world();
    await w.sell(450, 0, "card");
    await w.sell(300, 0, "card");
    const s = await w.sell(1000, 10, "send21");
    const token = s.sale.payUrl!.split("/").pop()!;
    await fetch(`${w.url}/mock/pay/${token}/paid`, { method: "POST", body: new URLSearchParams({ coin: "1" }) });
    const f = await w.sell(500, 0, "send21");
    await fetch(`${w.url}/mock/pay/${f.sale.payUrl!.split("/").pop()!}/wrong`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    await w.sell(700, 0, "send21");
    const sum = (await (await w.get("/api/summary")).json()) as Record<string, unknown>;
    expect(sum).toMatchObject({ cardSim: { count: 2, total: 750 }, send21: { count: 1, total: 1100, tips: 100 }, open: 1 });
    expect((sum.review as { id: string }[]).map((r) => r.id)).toEqual([f.id]);
    await w.close();
  });

  it("cancel, the deadline sweep, and the security headers", async () => {
    const w = await world({ TERMINAL_MINUTES: "1" });
    const s = await w.sell(100, 0, "send21");
    expect((await w.api(`/api/sales/${s.id}/cancel`)).status).toBe(200);
    expect((await w.api(`/api/sales/${s.id}/cancel`)).status).toBe(409);
    const t = await w.sell(100, 0, "send21");
    w.clock.now += 61_000;
    const r = await w.get(`/api/sales/${t.id}`);
    expect(((await r.json()) as { sale: { status: string } }).sale.status).toBe("expired");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const home = await w.get("/");
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    expect((await w.get("/api/sales/../../etc")).status).not.toBe(200);
    await w.close();
  });

  it("mock-only one-click demo login; not in live mode", async () => {
    const w = await world();
    const r = await fetch(`${w.url}/demo`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("set-cookie")).toMatch(/s21_pos=.*HttpOnly.*SameSite=Strict/i);
    await w.close();
    const live = await world({ SEND21_API_KEY: "s21_test", SEND21_WEBHOOK_SECRET: "whsec_x" });
    expect((await fetch(`${live.url}/demo`, { redirect: "manual" })).status).toBe(404);
    await live.close();
  });
});
