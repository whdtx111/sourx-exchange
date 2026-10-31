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

  public snapshot() { return {buckets: [...this.buckets.entries()]}; }
  public restore(data: ReturnType<MeteringService["snapshot"]> | undefined) {
    if (!data) return;
    for (const [key,value] of data.buckets) this.buckets.set(key,value);
  }

  public constructor(private readonly store: DomainStore, private readonly intervalSeconds = 30, private readonly clock: () => number = () => Date.now()) {
    if (intervalSeconds <= 0 || !Number.isInteger(intervalSeconds)) throw new Error("计量周期必须为正整数");
  }

  public record(input: { leaseId: string; observedAtEpoch: number; heartbeat: boolean; sandboxState: "ready" | "running" | "failed" | "stopped"; gpuUuid: string }): MeterBucket {
    const lease = this.store.leases.get(input.leaseId);
    if (!lease) throw notFound("租约");
    if (!Number.isInteger(input.observedAtEpoch) || input.observedAtEpoch <= 0 || input.observedAtEpoch > Math.floor(this.clock() / 1000) + 30) {
      throw new DomainError("INVALID_METER_TIME", "计量时间戳不合法或来自未来");
    }
    const node = this.store.nodes.get(lease.nodeId);
    const gpu = node?.gpus.find((candidate) => candidate.id === lease.gpuId);
    if (!gpu || gpu.uuid !== input.gpuUuid) throw new DomainError("METER_GPU_MISMATCH", "计量 GPU 与租约不匹配");
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
      billable: input.heartbeat && (input.sandboxState === "ready" || input.sandboxState === "running") && ["ready", "running"].includes(lease.status),
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

