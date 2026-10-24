import { DomainError } from "../domain/errors.js";
import type { Lease, Order } from "../domain/types.js";
import { MarketplaceService } from "../domain/service.js";
import { ArtifactService } from "./artifact.js";
import { WorkloadService } from "./job.js";

export interface CleanupRuntime {
  get(sandboxId: string): { status: string } | undefined;
  stop(sandboxId: string): unknown;
  destroy(sandboxId: string): unknown;
}

export interface CleanupReport {
  orderId: string;
  cancelledJobs: number;
  revokedTokens: boolean;
  sandboxDestroyed: boolean;
  deletedArtifacts: number;
}

/** Coordinates destructive order actions and releases the GPU last. */
export class OrderCleanupService {
  public constructor(
    private readonly marketplace: MarketplaceService,
    private readonly workload: WorkloadService,
    private readonly artifacts: ArtifactService,
    private readonly runtime?: CleanupRuntime,
  ) {}

  public endOrder(orderId: string): { order: Order; report: CleanupReport } {
    const order = this.marketplace.beginOrderEnding(orderId);
    const cancelledJobs = this.workload.cancelForOrder(orderId);
    this.marketplace.revokeLeaseTokens(orderId);

    try {
      const sandboxDestroyed = this.cleanupSandbox(this.marketplace.findLeaseForOrder(orderId));
      const deletedArtifacts = this.artifacts.deleteOrderArtifacts(orderId);
      const completed = this.marketplace.completeOrder(orderId);
      return {
        order: completed,
        report: { orderId, cancelledJobs, revokedTokens: true, sandboxDestroyed, deletedArtifacts },
      };
    } catch (error) {
      this.marketplace.markLeaseCleanupFailed(orderId, error instanceof Error ? error.message : "unknown cleanup error");
      throw new DomainError("CLEANUP_FAILED", "订单清理失败，GPU 仍被保留并等待重试");
    }
  }

  private cleanupSandbox(lease: Lease | undefined): boolean {
    if (!lease) return false;
    if (!lease.sandboxId || !this.runtime) return false;
    const record = this.runtime.get(lease.sandboxId);
    if (!record || record.status === "destroyed") return true;
    if (record.status === "running") this.runtime.stop(lease.sandboxId);
    this.runtime.destroy(lease.sandboxId);
    return true;
  }
}
