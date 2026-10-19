import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fiatDecimals } from "./currencies.js";
import type { Send21Client } from "./send21.js";
import type { Store, StoreData } from "./store.js";
import { TIPS, type PayOption, type Sale, type SaleMethod, type SaleStatus } from "./types.js";

// The terminal, without HTTP: sales, the card SIMULATION, send21 pay links and webhooks.

export interface PosConfig {
  shop: string;
  currency: string;
  options: PayOption[];
  /** Pay link life on send21 (hours, documented minimum 1). */
  expiryHours: number;
  /** How long the terminal shows the QR before it gives up (minutes). */
  terminalMinutes: number;
  shortfallPercent: number;
  /** Largest sale, in minor units. */
  maxAmount: number;
}

export const ORDER_ID = /^pos-([a-z0-9]{12})$/;
const newId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(12), (b) => abc[b % 36]).join("");
};
export const hashKey = (k: string) => createHash("sha256").update(k).digest("hex");
export function keyOk(k: string, hash: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(k)) return false;
  const a = Buffer.from(hashKey(k), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

/** minor units → major (€12.30) for send21's fiatAmount. */
export const toMajor = (minor: number, currency: string) => minor / 10 ** fiatDecimals(currency);

export class Pos {
  constructor(
    readonly store: Store,
    private readonly send21: Send21Client,
    readonly cfg: PosConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A new sale. amount is in minor units (what the keypad typed), tip one of 0/10/15/20 %.
   * card_sim: recorded as a DEMO approval, nothing is charged anywhere.
   * send21: ONE pay link for the total, orderId pos-<id> = Idempotency-Key.
   */
  async start(input: { amount: unknown; tipPercent: unknown; method: unknown }): Promise<Result<{ sale: Sale; receiptKey: string }>> {
    const amount = Number(input.amount);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > this.cfg.maxAmount) return { ok: false, error: "amount", status: 400 };
    const tipPercent = Number(input.tipPercent ?? 0);
    if (!(TIPS as readonly number[]).includes(tipPercent)) return { ok: false, error: "tip", status: 400 };
    const method = input.method === "card" ? "card_sim" : input.method === "send21" ? "send21" : null;
    if (!method) return { ok: false, error: "method", status: 400 };
    const tip = Math.round((amount * tipPercent) / 100);
    const receiptKey = randomBytes(32).toString("base64url");
    const id = newId();
    const nowIso = this.now().toISOString();
    const sale: Sale = {
      id,
      orderId: `pos-${id}`,
      method: method as SaleMethod,
      amount,
      tipPercent,
      tip,
      total: amount + tip,
      currency: this.cfg.currency,
      options: method === "send21" ? this.cfg.options : [],
      status: method === "card_sim" ? "approved_sim" : "open",
      paymentRequestId: null,
      payUrl: null,
      deadline: method === "send21" ? new Date(this.now().getTime() + this.cfg.terminalMinutes * 60_000).toISOString() : null,
      receiptHash: hashKey(receiptKey),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.store.transaction((d) => {
      d.sales[id] = sale;
    });
    if (method === "card_sim") return { ok: true, sale, receiptKey };
    try {
      const pr = await this.send21.createPaymentRequest(
        {
          fiatCurrency: sale.currency,
          fiatAmount: toMajor(sale.total, sale.currency),
          orderId: sale.orderId,
          memo: `🧾 ${this.cfg.shop}${sale.tip ? ` · tip ${sale.tipPercent}%` : ""}`.slice(0, 140),
          options: sale.options,
          expiryHours: this.cfg.expiryHours,
          declineNote: "No sale. Ask at the counter for a new one.",
          reuseOpenForOrder: true,
          ...(this.cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: this.cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
        },
        sale.orderId,
      );
      const updated = this.patch(id, { paymentRequestId: pr.id, payUrl: this.send21.payUrl(pr.payPath) });
      return { ok: true, sale: updated, receiptKey };
    } catch (err) {
      this.store.transaction((d) => {
        delete d.sales[id];
      });
      throw err;
    }
  }

  private patch(id: string, patch: Partial<Sale>): Sale {
    return this.store.transaction((d) => {
      d.sales[id] = { ...d.sales[id]!, ...patch, updatedAt: this.now().toISOString() };
      return d.sales[id]!;
    });
  }

  /** ✖️ Cancel on the terminal (only while nothing arrived). The link on send21 may stay open; a late payment is still recorded. */
  cancel(id: string): Result<{ sale: Sale }> {
    return this.store.transaction((d) => {
      const s = d.sales[id];
      if (!s) return { ok: false, error: "unknown sale", status: 404 };
      if (s.status !== "open") return { ok: false, error: `cannot cancel a ${s.status} sale`, status: 409 };
      d.sales[id] = { ...s, status: "cancelled", updatedAt: this.now().toISOString() };
      return { ok: true, sale: d.sales[id]! };
    });
  }

  /** The terminal stops waiting at the deadline. */
  sweep(d: StoreData, now = this.now()): Sale[] {
    const out: Sale[] = [];
    for (const s of Object.values(d.sales)) {
      if (["open", "seen"].includes(s.status) && s.deadline && Date.parse(s.deadline) < now.getTime()) {
        d.sales[s.id] = { ...s, status: "expired", updatedAt: now.toISOString() };
        out.push(d.sales[s.id]!);
      }
    }
    return out;
  }

  /** Today's numbers for the merchant panel. Card is a SIMULATION and kept apart. */
  summary(day = this.now().toISOString().slice(0, 10)) {
    const today = this.store.sales().filter((s) => s.createdAt.startsWith(day));
    const sum = (list: Sale[]) => list.reduce((n, s) => n + s.total, 0);
    const card = today.filter((s) => s.status === "approved_sim");
    const crypto = today.filter((s) => s.status === "paid");
    const review = this.store.sales().filter((s) => ["review", "flagged", "unresolved"].includes(s.status) || (s.status === "paid" && s.paid?.late));
    return {
      day,
      currency: this.cfg.currency,
      cardSim: { count: card.length, total: sum(card) },
      send21: { count: crypto.length, total: sum(crypto), tips: crypto.reduce((n, s) => n + s.tip, 0) },
      open: today.filter((s) => ["open", "seen", "accepted"].includes(s.status)).length,
      recent: [...today].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12).map(publicSale),
      review: review.map((s) => ({ ...publicSale(s), problems: s.problems ?? (s.paid?.late ? ["paid after the terminal stopped waiting"] : []) })),
    };
  }

  // ---------- webhooks ----------

  applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }): { outcome: Outcome; sale?: Sale } {
    const event = typeof body.event === "string" ? body.event : "";
    if (event === "test") return { outcome: "test" };
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
    const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
    if (data.orderId && !m) return { outcome: "unknown_sale" };
    const s = m ? d.sales[m[1]!] : Object.values(d.sales).find((x) => !!data.paymentRequestId && x.paymentRequestId === data.paymentRequestId);
    if (!s || s.method !== "send21" || !s.paymentRequestId || (data.paymentRequestId && data.paymentRequestId !== s.paymentRequestId)) return { outcome: "unknown_sale" };
    const nowIso = this.now().toISOString();
    const set = (status: SaleStatus, extra: Partial<Sale> = {}) => {
      d.sales[s.id] = { ...s, ...extra, status, updatedAt: nowIso };
      return { outcome: status, sale: d.sales[s.id] };
    };
    const is = (...x: SaleStatus[]) => x.includes(s.status);
    const same = { outcome: "unchanged" as const, sale: s };
    switch (event) {
      case "draft.confirmed": {
        if (s.status === "paid") return { outcome: "already_paid", sale: s };
        const problems = checkPaymentAgainstSale(data, s);
        if (problems.length) return set("flagged", { problems });
        return set("paid", {
          problems: undefined,
          paid: {
            currency: String(data.sentCurrency),
            network: String(data.network),
            amount: data.receivedAmount ?? data.sentAmount ?? null,
            txId: String(data.txId),
            differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
            late: is("expired", "cancelled", "declined"),
            at: nowIso,
          },
        });
      }
      case "draft.seen":
        return is("open") ? set("seen") : same;
      case "draft.amount_mismatch":
        return is("open", "seen", "expired", "cancelled") ? set("review", { problems: ["a different amount arrived: accept or decline it on send21"] }) : same;
      case "draft.mismatch_accepted":
        return is("paid", "declined") ? same : set("accepted");
      case "draft.mismatch_rejected":
        return is("paid") ? same : set("declined");
      case "draft.mismatch_unresolved":
        return is("open", "seen", "review", "expired", "cancelled") ? set("unresolved", { problems: ["expired undecided: money arrived, nobody decided"] }) : same;
      case "draft.expired":
        if (data.reviewState === "unresolved") return is("open", "seen", "review", "expired", "cancelled") ? set("unresolved", { problems: ["expired undecided: money arrived, nobody decided"] }) : same;
        return is("open", "seen") ? set("expired") : same;
      case "payment_request.expired":
        return is("open", "seen") ? set("expired") : same;
      default:
        return { outcome: "ignored", sale: s };
    }
  }
}

/** What the terminal and the panel may see: no receipt hash, no addresses. */
export function publicSale(s: Sale) {
  return {
    id: s.id,
    method: s.method,
    amount: s.amount,
    tipPercent: s.tipPercent,
    tip: s.tip,
    total: s.total,
    currency: s.currency,
    status: s.status,
    payUrl: s.payUrl,
    deadline: s.deadline,
    paid: s.paid ? { currency: s.paid.currency, network: s.paid.network, amount: s.paid.amount, late: s.paid.late, differentAmount: s.paid.differentAmount, at: s.paid.at } : null,
    problems: s.problems ?? [],
    createdAt: s.createdAt,
  };
}

export type Outcome = "test" | "ignored" | "unknown_sale" | "unchanged" | "already_paid" | SaleStatus;

export interface DraftEventData {
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** A draft.confirmed must be exactly this sale. Empty = OK. */
export function checkPaymentAgainstSale(data: DraftEventData, s: Sale): string[] {
  const problems: string[] = [];
  if (data.orderId !== s.orderId) problems.push(`saleId ${data.orderId} != ${s.orderId}`);
  if (!s.paymentRequestId || data.paymentRequestId !== s.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${s.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, s.currency)) problems.push(`fiat ${data.fiatCurrency} != ${s.currency}`);
  const scale = 10 ** fiatDecimals(s.currency);
  if (typeof data.fiatAmount !== "number" || Math.round(data.fiatAmount * scale) !== s.total) problems.push(`amount ${data.fiatAmount} != ${toMajor(s.total, s.currency)}`);
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  if (!s.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network))) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered`);
  return problems;
}
