import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { confirmedFor, deliver, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const rung = async (w: W, amount = 1200, tip = 0) => (await w.sell(amount, tip, "send21")).stored();
const ev = (event: string, s: Parameters<typeof confirmedFor>[0], data: Record<string, unknown> = {}) => ({ event, data: { ...confirmedFor(s).data, status: "AwaitingPayment", ...data } });

describe("send21 webhook: verify, dedupe, then apply", () => {
  it("401 on a bad signature or one older than 300 s, 400 on bad JSON, nothing changes", async () => {
    const w = await world();
    const s = await rung(w);
    expect((await deliver(w.url, confirmedFor(s), { secret: "wrong" })).status).toBe(401);
    expect((await deliver(w.url, confirmedFor(s), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await deliver(w.url, null, { raw: "{nope" })).status).toBe(400);
    expect(w.store.get(s.id)?.status).toBe("open");
    await w.close();
  });

  it("✅ paid once; the same delivery id or the same body again is a duplicate", async () => {
    const w = await world();
    const s = await rung(w, 1200, 15);
    const raw = JSON.stringify(confirmedFor(s));
    const id = crypto.randomUUID();
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, outcome: "paid" });
    expect(w.store.get(s.id)?.paid).toMatchObject({ currency: "USDC", network: "Solana", late: false });
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, null, { raw })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, confirmedFor(s))).json()).toEqual({ ok: true, outcome: "already_paid" });
    await w.close();
  });

  it("remembers deliveries across a restart; a failed write answers 500 so send21 retries", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pos-")), "d.json");
    const a = await world({ DATA_FILE: file });
    const s = await rung(a);
    const raw = JSON.stringify(confirmedFor(s));
    const id = crypto.randomUUID();
    const spy = vi.spyOn(Store.prototype as never, "persist" as never).mockImplementationOnce((() => {
      throw new Error("disk full");
    }) as never);
    expect((await deliver(a.url, null, { raw, deliveryId: id })).status).toBe(500);
    spy.mockRestore();
    expect(a.store.get(s.id)?.status).toBe("open");
    expect((await (await deliver(a.url, null, { raw, deliveryId: id })).json()) as object).toMatchObject({ outcome: "paid" });
    await a.close();
    const b = await world({ DATA_FILE: file });
    expect(b.store.get(s.id)?.status).toBe("paid");
    expect(await (await deliver(b.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    await b.close();
  });

  it.each([
    ["amount", { fiatAmount: 11.99 }],
    ["asset", { sentCurrency: "ETH", network: "Arbitrum" }],
    ["fiat", { fiatCurrency: "USD" }],
  ])("🚩 a confirmed payment with the wrong %s is flagged, never paid", async (what, over) => {
    const w = await world();
    const s = await rung(w);
    expect(await (await deliver(w.url, confirmedFor(s, over))).json()).toEqual({ ok: true, outcome: "flagged" });
    const after = w.store.get(s.id)!;
    expect(after.status).toBe("flagged");
    expect(after.problems!.join(" ")).toContain(what);
    const sum = (await (await w.get("/api/summary")).json()) as { review: { id: string }[]; send21: { count: number } };
    expect(sum.review.map((r) => r.id)).toEqual([s.id]);
    expect(sum.send21.count).toBe(0);
    await w.close();
  });

  it("🚩 another sale's saleId, or an unknown one, cannot pay this sale", async () => {
    const w = await world();
    const a = await rung(w);
    const b = await rung(w);
    expect(await (await deliver(w.url, confirmedFor(a, { orderId: b.orderId }))).json()).toEqual({ ok: true, outcome: "unknown_sale" });
    expect(await (await deliver(w.url, confirmedFor(a, { orderId: "pos-zzzzzzzzzzzz" }))).json()).toEqual({ ok: true, outcome: "unknown_sale" });
    expect(await (await deliver(w.url, confirmedFor(a, { orderId: "shop-abc" }))).json()).toEqual({ ok: true, outcome: "unknown_sale" });
    expect([w.store.get(a.id)?.status, w.store.get(b.id)?.status]).toEqual(["open", "open"]);
    await w.close();
  });

  it("⚠️ a different amount → review → declined; or accepted → paid", async () => {
    const w = await world();
    const s = await rung(w);
    await deliver(w.url, ev("draft.seen", s, { status: "Seen" }));
    expect(w.store.get(s.id)?.status).toBe("seen");
    await deliver(w.url, ev("draft.amount_mismatch", s, { reviewState: "pending", receivedAmountSats: 11_400_000 }));
    expect(w.store.get(s.id)?.status).toBe("review");
    await deliver(w.url, ev("draft.mismatch_rejected", s, { reviewState: "rejected" }));
    expect(w.store.get(s.id)?.status).toBe("declined");

    const t = await rung(w);
    await deliver(w.url, ev("draft.amount_mismatch", t, { reviewState: "pending", receivedAmountSats: 11_400_000 }));
    await deliver(w.url, ev("draft.mismatch_accepted", t, { reviewState: "accepted" }));
    expect(w.store.get(t.id)?.status).toBe("accepted");
    await deliver(w.url, confirmedFor(t, { receivedAmountSats: 11_400_000 }));
    expect(w.store.get(t.id)?.paid).toMatchObject({ differentAmount: true });
    await w.close();
  });

  it("⌛ expired; a late payment still counts as paid but is marked late for the merchant", async () => {
    const w = await world();
    const s = await rung(w);
    await deliver(w.url, { event: "payment_request.expired", data: { paymentRequestId: s.paymentRequestId, orderId: s.orderId } });
    expect(w.store.get(s.id)?.status).toBe("expired");
    await deliver(w.url, confirmedFor(s));
    expect(w.store.get(s.id)?.paid?.late).toBe(true);
    const sum = (await (await w.get("/api/summary")).json()) as { review: { problems: string[] }[] };
    expect(sum.review[0]!.problems[0]).toMatch(/after the terminal/);
    await w.close();
  });

  it("card sales ignore webhooks; test events are fine", async () => {
    const w = await world();
    const c = (await w.sell(500, 0, "card")).stored();
    expect(await (await deliver(w.url, confirmedFor({ ...c, paymentRequestId: "pr-x" }))).json()).toEqual({ ok: true, outcome: "unknown_sale" });
    expect(await (await deliver(w.url, { event: "test", data: {} })).json()).toEqual({ ok: true, outcome: "test" });
    expect(w.store.get(c.id)?.status).toBe("approved_sim");
    await w.close();
  });
});
