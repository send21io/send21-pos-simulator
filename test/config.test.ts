import { describe, expect, it } from "vitest";
import { loadConfig, parseOptions } from "../src/config.js";
import { MERCHANT, SOL } from "./helpers.js";

describe("config", () => {
  it("mock mode needs no keys at all", () => {
    const c = loadConfig({});
    expect(c.mock).toBe(true);
    expect(c.options.length).toBeGreaterThan(0);
    expect(c.merchantToken.length).toBeGreaterThanOrEqual(24);
    expect(c.currency).toBe("EUR");
    expect(c.maxAmount).toBe(100000);
  });

  it("live mode wants a webhook secret, addresses and a merchant token", () => {
    const base = { SEND21_API_KEY: "s21_x", SEND21_WEBHOOK_SECRET: "whsec", PAY_OPTIONS: `usdc-sol:${SOL}`, MERCHANT_TOKEN: MERCHANT };
    expect(loadConfig(base).mock).toBe(false);
    expect(() => loadConfig({ ...base, SEND21_WEBHOOK_SECRET: "" })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, PAY_OPTIONS: "" })).toThrow(/addresses/);
    expect(() => loadConfig({ ...base, MERCHANT_TOKEN: "short" })).toThrow(/MERCHANT_TOKEN/);
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "sk_nope" })).toThrow(/s21_/);
    expect(() => loadConfig({ ...base, CURRENCY: "JPY" })).toThrow(/CURRENCY/);
  });

  it("no USDT or BTC on Base; unknown coins are refused", () => {
    expect(() => parseOptions(undefined, "usdt-base:0x52908400098527886E0F7030069857D2E4169EE7")).toThrow(/unknown coin/);
    expect(() => parseOptions(undefined, "btc-base:0x52908400098527886E0F7030069857D2E4169EE7")).toThrow(/unknown coin/);
    expect(parseOptions(undefined, `usdt-sol:${SOL}`)[0]).toMatchObject({ currency: "Usdt", network: "Solana" });
  });
});
