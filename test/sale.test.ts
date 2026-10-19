import { describe, expect, it } from "vitest";
import { checkPaymentAgainstSale, Pos } from "../src/pos.js";
import type { CreatePaymentRequest, Send21Client } from "../src/send21.js";
import { Store } from "../src/store.js";
import { testConfig } from "./helpers.js";

function fakeClient() {
  const calls: { body: CreatePaymentRequest; key: string }[] = [];
  const client: Send21Client = {
    mode: "mock",
    payUrl: (p) => `https://send21.io${p}`,
    async createPaymentRequest(body, key) {
      calls.push({ body, key });
      return { id: `pr-${calls.length}`, payPath: `/pay/t${calls.length}`, status: "Open", expiresAt: new Date(Date.now() + 3600_000).toISOString() } as never;
    },
  };
  return { client, calls };
}
const cfg = testConfig();
const posWith = (client: Send21Client, now = () => new Date()) =>
  new Pos(new Store(":memory:"), client, { shop: cfg.shop, currency: "EUR", options: cfg.options, expiryHours: 1, terminalMinutes: 10, shortfallPercent: 0, maxAmount: 100000 }, now);

describe("sales", () => {
  it("💳 card is a simulation: approved_sim, no pay link, no send21 call", async () => {
    const { client, calls } = fakeClient();
    const r = await posWith(client).start({ amount: 450, tipPercent: 10, method: "card" });
    expect(r.ok && r.sale).toMatchObject({ method: "card_sim", status: "approved_sim", total: 495, payUrl: null, options: [] });
    expect(calls).toHaveLength(0);
  });

  it("⚡ send21: one pay link for amount + tip, orderId pos-<id> is the Idempotency-Key", async () => {
    const { client, calls } = fakeClient();
    const r = await posWith(client).start({ amount: 1200, tipPercent: 15, method: "send21" });
    if (!r.ok) throw new Error(r.error);
    expect(r.sale.total).toBe(1380);
    expect(r.sale.orderId).toMatch(/^pos-[a-z0-9]{12}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(r.sale.orderId);
    expect(calls[0]!.body).toMatchObject({ fiatCurrency: "EUR", fiatAmount: 13.8, orderId: r.sale.orderId, reuseOpenForOrder: true, expiryHours: 1 });
    expect(r.sale.payUrl).toBe("https://send21.io/pay/t1");
    expect(r.receiptKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.sale.receiptHash).not.toContain(r.receiptKey);
  });

  it("tips are 0/10/15/20 % and rounded to the cent", async () => {
    const pos = posWith(fakeClient().client);
    const tipOf = async (amount: number, t: number) => {
      const r = await pos.start({ amount, tipPercent: t, method: "card" });
      return r.ok ? r.sale.tip : null;
    };
    expect(await tipOf(999, 0)).toBe(0);
    expect(await tipOf(999, 10)).toBe(100);
    expect(await tipOf(999, 15)).toBe(150);
    expect(await tipOf(333, 20)).toBe(67);
    expect(await tipOf(999, 12)).toBeNull();
  });

  it("refuses silly amounts and methods", async () => {
    const pos = posWith(fakeClient().client);
    for (const amount of [0, -5, 1.5, "12", 100001, null]) {
      const r = await pos.start({ amount, tipPercent: 0, method: "card" });
      if (typeof amount === "string") expect(r.ok).toBe(true);
      else expect(r.ok).toBe(false);
    }
    expect((await pos.start({ amount: 100, tipPercent: 0, method: "visa" })).ok).toBe(false);
  });

  it("a failed pay link leaves no half-made sale", async () => {
    const client: Send21Client = { mode: "mock", payUrl: (p) => p, createPaymentRequest: async () => Promise.reject(new Error("down")) };
    const pos = posWith(client);
    await expect(pos.start({ amount: 100, tipPercent: 0, method: "send21" })).rejects.toThrow("down");
    expect(pos.store.sales()).toHaveLength(0);
  });

  it("the terminal stops waiting at its deadline, and can cancel an open sale", async () => {
    let now = Date.now();
    const pos = posWith(fakeClient().client, () => new Date(now));
    const a = await pos.start({ amount: 100, tipPercent: 0, method: "send21" });
    const b = await pos.start({ amount: 200, tipPercent: 0, method: "send21" });
    if (!a.ok || !b.ok) throw new Error();
    expect(pos.cancel(b.sale.id)).toMatchObject({ ok: true });
    expect(pos.cancel(b.sale.id)).toMatchObject({ ok: false, status: 409 });
    now += 9 * 60_000;
    expect(pos.store.transaction((d) => pos.sweep(d))).toHaveLength(0);
    now += 2 * 60_000;
    expect(pos.store.transaction((d) => pos.sweep(d)).map((s) => s.id)).toEqual([a.sale.id]);
    expect(pos.store.get(a.sale.id)?.status).toBe("expired");
  });
});

describe("checkPaymentAgainstSale", () => {
  const sale = { orderId: "pos-abcdefghij12", paymentRequestId: "pr-1", total: 1380, currency: "EUR", options: [{ currency: "Usdc", network: "Solana", address: "x" }] } as never;
  const good = { orderId: "pos-abcdefghij12", paymentRequestId: "pr-1", status: "Confirmed", txId: "t", fiatCurrency: "EUR", fiatAmount: 13.8, amountSats: 13_800_000, sentCurrency: "USDC", network: "Solana" };
  it("exact match passes (asset case-insensitive)", () => {
    expect(checkPaymentAgainstSale(good, sale)).toEqual([]);
  });
  it.each([
    ["amount", { fiatAmount: 13.79 }],
    ["fiat", { fiatCurrency: "USD" }],
    ["asset", { sentCurrency: "ETH", network: "Arbitrum" }],
    ["asset", { network: "Ethereum" }],
    ["saleId", { orderId: "pos-zzzzzzzzzzzz" }],
    ["pay link", { paymentRequestId: "pr-2" }],
    ["status", { status: "Seen" }],
    ["txId", { txId: "" }],
    ["amountSats", { amountSats: 0 }],
  ])("flags a wrong %s", (what, over) => {
    expect(checkPaymentAgainstSale({ ...good, ...over }, sale).join(" ")).toContain(what);
  });
});
