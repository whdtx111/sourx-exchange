import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { MarketplaceService } from "../domain/service.js";
import type { Payment } from "../domain/types.js";

export type PaymentWebhookStatus = "authorized" | "captured" | "failed" | "voided";

export interface PaymentWebhookEvent {
  eventId: string;
  paymentId: string;
  status: PaymentWebhookStatus;
  providerReference: string;
}

const signatureFor = (secret: string, event: PaymentWebhookEvent): string =>
  createHmac("sha256", secret).update(JSON.stringify(event)).digest("hex");

export class PaymentWebhookProcessor {
  private readonly processed = new Map<string, { fingerprint: string; payment: Payment }>();

  public constructor(private readonly marketplace: MarketplaceService, private readonly secret: string) {
    if (secret.length < 32) throw new Error("支付 webhook secret 至少需要 32 个字符");
  }

  public sign(event: PaymentWebhookEvent): string {
    return signatureFor(this.secret, event);
  }

  public handle(event: PaymentWebhookEvent, signature: string): Payment {
    const existing = this.processed.get(event.eventId);
    const fingerprint = JSON.stringify(event);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DomainError("WEBHOOK_ID_REUSE", "支付 webhook eventId 已对应其他事件");
      return existing.payment;
    }
    const expected = signatureFor(this.secret, event);
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new DomainError("INVALID_WEBHOOK_SIGNATURE", "支付 webhook 签名无效");
    if (!event.eventId || event.eventId.length > 128 || !event.providerReference) throw new DomainError("INVALID_WEBHOOK", "支付 webhook 参数不合法");
    const payment = this.marketplace.applyPaymentWebhook(event.paymentId, event.status, event.providerReference);
    this.processed.set(event.eventId, { fingerprint, payment });
    return payment;
  }
}
