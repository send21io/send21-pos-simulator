/** One pay-link option: a coin the merchant accepts and their own receiving address. */
export interface PayOption {
  currency: string;
  network: string;
  address: string;
  method?: string;
}

/** "card_sim" is a SIMULATION ONLY: no card data, no card network, no money. */
export type SaleMethod = "card_sim" | "send21";

export type SaleStatus =
  | "approved_sim" // 💳 demo only, no real card
  | "open" // 📱 send21 QR on screen
  | "seen" // 👀 payment on its way
  | "review" // ⚠️ a different amount arrived, the merchant decides on send21
  | "accepted" // 👍 accepted, waiting for draft.confirmed
  | "paid" // ✅ receipt
  | "declined" // ↩️ different amount declined
  | "unresolved" // ⚠️ expired undecided, money arrived
  | "expired" // ⌛
  | "flagged" // 🚩 confirmed but it does not match the sale
  | "cancelled"; // ✖️ cancelled on the terminal before anything arrived

export const TIPS = [0, 10, 15, 20] as const;

export interface Sale {
  /** Random 12 × [a-z0-9]. orderId on send21 is pos-<id>, also the Idempotency-Key. */
  id: string;
  orderId: string;
  method: SaleMethod;
  /** Minor units (cents). */
  amount: number;
  tipPercent: number;
  tip: number;
  total: number;
  currency: string;
  options: PayOption[];
  status: SaleStatus;
  paymentRequestId: string | null;
  payUrl: string | null;
  /** When the terminal stops waiting (local). The pay link itself may live longer. */
  deadline: string | null;
  /** sha256 of the receipt key; the key is only in the receipt QR. */
  receiptHash: string;
  paid?: { currency: string; network: string; amount: string | null; txId: string; differentAmount: boolean; late: boolean; at: string };
  problems?: string[];
  createdAt: string;
  updatedAt: string;
}
