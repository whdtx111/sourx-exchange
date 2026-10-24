import { DomainError, notFound } from "../domain/errors.js";
import type { DomainStore } from "../domain/store.js";

export interface MeterBucket {
  id: string;
  leaseId: string;
  orderId: string;
  bucketStartEpoch: number;
  intervalSeconds: number;
  billable: boolean;
  observedAt: string;
  evidence: { heartbeat: boolean; sandboxState: string; gpuUuid: string };
}

export class MeteringService {
  private readonly buckets = new Map<string, MeterBucket>();

  public constructor(private readonly store: DomainStore, private readonly intervalSeconds = 30) {
    if (intervalSeconds <= 0 || !Number.isInteger(intervalSeconds)) throw new Error("计量周期必须为正整数");
  }

  public record(input: { leaseId: string; observedAtEpoch: number; heartbeat: boolean; sandboxState: "ready" | "running" | "failed" | "stopped"; gpuUuid: string }): MeterBucket {
    const lease = this.store.leases.get(input.leaseId);
    if (!lease) throw notFound("租约");
    const bucketStartEpoch = Math.floor(input.observedAtEpoch / this.intervalSeconds) * this.intervalSeconds;
    const key = `${lease.id}:${bucketStartEpoch}`;
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const bucket: MeterBucket = {
      id: `meter_${lease.id}_${bucketStartEpoch}`,
      leaseId: lease.id,
      orderId: lease.orderId,
      bucketStartEpoch,
      intervalSeconds: this.intervalSeconds,
      billable: input.heartbeat && (input.sandboxState === "ready" || input.sandboxState === "running") && lease.status !== "ended",
      observedAt: new Date(input.observedAtEpoch * 1000).toISOString(),
      evidence: { heartbeat: input.heartbeat, sandboxState: input.sandboxState, gpuUuid: input.gpuUuid },
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  public listForOrder(orderId: string): MeterBucket[] {
    return [...this.buckets.values()].filter((bucket) => bucket.orderId === orderId).sort((a, b) => a.bucketStartEpoch - b.bucketStartEpoch);
  }

  public billableSeconds(orderId: string): number {
    return this.listForOrder(orderId).filter((bucket) => bucket.billable).reduce((total, bucket) => total + bucket.intervalSeconds, 0);
  }
}

