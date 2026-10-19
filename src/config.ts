import "dotenv/config";
import { randomBytes } from "node:crypto";
import { checkAddress, coinById, fiatDecimals } from "./currencies.js";
import { cleanText } from "./sanitize.js";
import type { PayOption } from "./types.js";

export interface Config {
  /** null = mock send21: pay links open the local /mock/pay page. */
  send21ApiKey: string | null;
  send21ApiBase: string;
  webhookSecret: string;
  /** Opens the terminal and the merchant panel. */
  merchantToken: string;
  port: number;
  publicUrl: string;
  trustProxy: boolean;
  shop: string;
  currency: string;
  options: PayOption[];
  expiryHours: number;
  terminalMinutes: number;
  shortfallPercent: number;
  maxAmount: number;
  dataFile: string;
  mock: boolean;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string): number => {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

/**
 * PAY_LIGHTNING=name@your-wallet.com and PAY_OPTIONS=usdc-sol:<address>,eth-base:<address>
 * (coin ids from src/currencies.ts). Your own addresses only.
 */
export function parseOptions(lightning: string | undefined, list: string | undefined): PayOption[] {
  const entries: [string, string][] = [];
  if (lightning?.trim()) entries.push(["btc-ln", lightning.trim()]);
  for (const part of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`PAY_OPTIONS: "${part}" should be coin:address`);
    entries.push([part.slice(0, i), part.slice(i + 1)]);
  }
  const options: PayOption[] = [];
  for (const [id, raw] of entries) {
    const coin = coinById(id);
    if (!coin) throw new Error(`PAY_OPTIONS: unknown coin "${id}"`);
    if (options.some((o) => o.currency === coin.currency && o.network === coin.network && o.method === coin.method)) throw new Error(`PAY_OPTIONS: ${id} twice`);
    const address = checkAddress(coin, raw);
    if (!address.ok) throw new Error(`PAY_OPTIONS ${id}: ${address.error}`);
    options.push({ currency: coin.currency, network: coin.network, address: address.address, ...(coin.method ? { method: coin.method } : {}) });
  }
  return options;
}

const MOCK_LIGHTNING = "till@wallet.example";
const MOCK_OPTIONS = "usdc-sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,usdt-sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,eurc-base:0x52908400098527886E0F7030069857D2E4169EE7";
const FIATS = ["EUR", "USD", "GBP"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SEND21_API_KEY?.trim() || null;
  const mock = !apiKey;
  if (apiKey && !apiKey.startsWith("s21_")) throw new Error("SEND21_API_KEY should start with s21_");
  const secret = env.SEND21_WEBHOOK_SECRET?.trim();
  if (!mock && !secret) throw new Error("SEND21_WEBHOOK_SECRET is missing (npm run webhook:register)");
  const port = num(env.PORT, 3000, 1, 65535, "PORT");
  const publicUrl = (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, "");

  const currency = (env.CURRENCY?.trim() || "EUR").toUpperCase();
  if (!FIATS.includes(currency)) throw new Error(`CURRENCY must be one of ${FIATS.join(", ")}`);

  const configured = parseOptions(env.PAY_LIGHTNING, env.PAY_OPTIONS);
  const options = configured.length ? configured : mock ? parseOptions(MOCK_LIGHTNING, MOCK_OPTIONS) : [];
  if (!options.length) throw new Error("Set PAY_LIGHTNING and/or PAY_OPTIONS to your own receiving addresses");

  const merchantToken = env.MERCHANT_TOKEN?.trim() || (mock ? randomBytes(18).toString("base64url") : "");
  if (merchantToken.length < 24) throw new Error("MERCHANT_TOKEN: at least 24 characters (openssl rand -base64 24)");

  const scale = 10 ** fiatDecimals(currency);
  return {
    send21ApiKey: apiKey,
    send21ApiBase: env.SEND21_API_BASE?.trim() || "https://send21.io",
    webhookSecret: secret || randomBytes(32).toString("hex"),
    merchantToken,
    port,
    publicUrl,
    trustProxy: env.TRUST_PROXY === "1",
    shop: cleanText(env.SHOP_NAME ?? "", 40) || "Corner Café",
    currency,
    options,
    expiryHours: Math.round(num(env.LINK_EXPIRY_HOURS, 1, 1, 24, "LINK_EXPIRY_HOURS")),
    terminalMinutes: Math.round(num(env.TERMINAL_MINUTES, 10, 1, 60, "TERMINAL_MINUTES")),
    shortfallPercent: num(env.SHORTFALL_PERCENT, 0, 0, 10, "SHORTFALL_PERCENT"),
    maxAmount: Math.round(num(env.MAX_AMOUNT, 1000, 1, 100000, "MAX_AMOUNT") * scale),
    dataFile: env.DATA_FILE?.trim() || "./data/pos.json",
    mock,
  };
}
