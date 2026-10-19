import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { buildPos } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const MERCHANT = "merchant-token-for-tests-only-0123456789";

export function testConfig(env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({ DATA_FILE: ":memory:", PAY_LIGHTNING: "till@wallet.example", PAY_OPTIONS: `usdc-sol:${SOL}`, MERCHANT_TOKEN: MERCHANT, ...env }),
    webhookSecret: SECRET,
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function world(env: Record<string, string> = {}, opts: Parameters<typeof buildPos>[1] = {}) {
  const logs: string[] = [];
  const clock = { now: Date.now() };
  const cfg = testConfig(env);
  const w = buildPos(cfg, { log: (l) => logs.push(l), now: () => new Date(clock.now), ...opts });
  const server = await listen(w.app);
  if (w.mockPay) w.mockPay.selfUrl = server.url;
  const login = await fetch(`${server.url}/login`, { method: "POST", redirect: "manual", body: new URLSearchParams({ token: MERCHANT }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const get = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, { redirect: "manual", ...init, headers: { cookie, ...(init.headers as Record<string, string>) } });
  const api = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: "POST", redirect: "manual", body: JSON.stringify(body), headers: { "content-type": "application/json", cookie, ...headers } });
  /** Ring up a sale like the terminal does. */
  const sell = async (amount = 1200, tipPercent = 0, method: "card" | "send21" = "send21") => {
    const r = await api("/api/sales", { amount, tipPercent, method });
    const j = (await r.json()) as { sale: { id: string; payUrl: string | null }; qr: string | null; receiptUrl: string; receiptQr: string };
    return { ...j, id: j.sale.id, stored: () => w.store.get(j.sale.id)! };
  };
  return { ...w, ...server, cfg, logs, clock, cookie, get, api, sell };
}

export function confirmedFor(s: { orderId: string; paymentRequestId: string | null; total: number; currency: string }, over: Record<string, unknown> = {}) {
  const major = s.total / 100;
  return {
    event: "draft.confirmed",
    data: {
      draftId: crypto.randomUUID(),
      status: "Confirmed",
      txId: "5hRk-sig",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: Math.round(major * 1e6),
      sentAmount: major.toFixed(6),
      fiatCurrency: s.currency,
      fiatAmount: major,
      paymentRequestId: s.paymentRequestId ?? undefined,
      orderId: s.orderId,
      occurredAt: new Date().toISOString(),
      ...over,
    },
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
