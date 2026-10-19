import { buildPos } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const { app, sweep } = buildPos(cfg);

app.listen(cfg.port, cfg.mock ? "127.0.0.1" : "0.0.0.0", () => {
  console.log(`🧾 ${cfg.shop} terminal ${cfg.publicUrl}/  ·  🪝 /webhooks/send21`);
  console.log("💳 card = SIMULATION ONLY (demo, no real card): nothing is ever charged.");
  if (cfg.mock) {
    console.log("🧪 MOCK send21: no send21 calls, pay links open a local simulator.");
    console.log(`🧪 one-click: ${cfg.publicUrl}/demo`);
  }
  setInterval(sweep, 30_000).unref();
  sweep();
});
