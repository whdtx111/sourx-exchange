import { DomainError, notFound } from "../domain/errors.js";
import type { DomainStore } from "../domain/store.js";
import { MeteringService } from "./metering.js";

export interface LedgerEntry {
  id: string;
  orderId: string;
  type: "compute_charge" | "platform_fee" | "provider_payout" | "refund";
  amountMinor: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface Settlement {
  id: string;
  orderId: string;
  billableSeconds: number;
  computeAmountMinor: number;
  platformFeeMinor: number;
  providerPayoutMinor: number;
  status: "settled" | "frozen" | "refunded";
  createdAt: string;
}

export class SettlementService {
  private readonly settlements = new Map<string, Settlement>();
  private readonly ledger: LedgerEntry[] = [];

  public constructor(private readonly store: DomainStore, private readonly metering: MeteringService, private readonly clock: () => number = () => Date.now()) {}

  public dispute(orderId: string): Settlement | null {
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (order.status === "disputed") return this.settlements.get(orderId) ?? null;
    if (!["completed", "ending"].includes(order.status)) throw new DomainError("ORDER_NOT_DISPUTABLE", "订单当前不能发起争议");
    order.status = "disputed";
    const payment = [...this.store.payments.values()].find((candidate) => candidate.orderId === orderId);
    if (payment) payment.status = "disputed";
    const settlement = this.settlements.get(orderId);
    if (settlement) settlement.status = "frozen";
    return settlement ?? null;
  }

  public settle(orderId: string): Settlement {
    const existing = this.settlements.get(orderId);
    if (existing) return existing;
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (order.status === "disputed") throw new DomainError("ORDER_DISPUTED", "争议订单不能自动结算");
    if (order.status !== "completed") throw new DomainError("ORDER_NOT_COMPLETED", "订单尚未完成");
    const payment = [...this.store.payments.values()].find((candidate) => candidate.orderId === orderId);
    if (!payment || !["authorized", "captured"].includes(payment.status)) throw new DomainError("PAYMENT_NOT_SETTLEABLE", "支付状态不能结算");
    const billableSeconds = this.metering.billableSeconds(orderId);
    const computeAmountMinor = Math.min(order.computeAmountMinor, Math.ceil((order.pricePerHourMinor * billableSeconds) / 3600));
    const platformFeeMinor = Math.floor((computeAmountMinor * 500) / 10_000);
    const providerPayoutMinor = computeAmountMinor - platformFeeMinor;
    const settlement: Settlement = {
      id: `stl_${orderId}`,
      orderId,
      billableSeconds,
      computeAmountMinor,
      platformFeeMinor,
      providerPayoutMinor,
      status: "settled",
      createdAt: new Date(this.clock()).toISOString(),
    };
    payment.status = "settled";
    this.settlements.set(orderId, settlement);
    this.ledger.push(
      { id: `led_${orderId}_compute`, orderId, type: "compute_charge", amountMinor: computeAmountMinor, createdAt: settlement.createdAt, metadata: { billableSeconds } },
      { id: `led_${orderId}_fee`, orderId, type: "platform_fee", amountMinor: platformFeeMinor, createdAt: settlement.createdAt, metadata: {} },
      { id: `led_${orderId}_payout`, orderId, type: "provider_payout", amountMinor: providerPayoutMinor, createdAt: settlement.createdAt, metadata: {} },
    );
    return settlement;
  }

  public refund(orderId: string): Settlement {
    const settlement = this.settlements.get(orderId);
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (settlement?.status === "refunded") return settlement;
    if (!settlement) {
      const payment = [...this.store.payments.values()].find((candidate) => candidate.orderId === orderId);
      if (payment) payment.status = "partially_refunded";
      order.status = "refunded";
      const created: Settlement = { id: `stl_${orderId}`, orderId, billableSeconds: 0, computeAmountMinor: 0, platformFeeMinor: 0, providerPayoutMinor: 0, status: "refunded", createdAt: new Date(this.clock()).toISOString() };
      this.settlements.set(orderId, created);
      this.ledger.push({ id: `led_${orderId}_refund`, orderId, type: "refund", amountMinor: order.totalAmountMinor, createdAt: created.createdAt, metadata: {} });
      return created;
    }
    settlement.status = "refunded";
    order.status = "refunded";
    this.ledger.push({ id: `led_${orderId}_refund`, orderId, type: "refund", amountMinor: settlement.computeAmountMinor, createdAt: new Date(this.clock()).toISOString(), metadata: {} });
    return settlement;
  }

  public getLedger(): readonly LedgerEntry[] {
    return this.ledger;
  }
}

