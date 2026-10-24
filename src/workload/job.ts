import { id, type DomainStore } from "../domain/store.js";
import { DomainError, forbidden, notFound } from "../domain/errors.js";
import { CapabilityTokenService, type CapabilityScope } from "../agent/security.js";

export type JobStatus = "created" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";

export interface Job {
  id: string;
  orderId: string;
  leaseId: string;
  ownerId: string;
  imageDigest: string;
  command: string[];
  inputArtifactIds: string[];
  status: JobStatus;
  maxRuntimeSeconds: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  outputArtifactIds: string[];
}

export interface SubmitJobInput {
  orderId: string;
  leaseId: string;
  imageDigest: string;
  command: string[];
  inputArtifactIds: string[];
  maxRuntimeSeconds: number;
}

const allowedStatuses = new Set(["ready", "running"]);

export class WorkloadService {
  private readonly jobs = new Map<string, Job>();

  public constructor(
    private readonly store: DomainStore,
    private readonly tokens: CapabilityTokenService,
    private readonly allowedImages: readonly string[],
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public submit(token: string, input: SubmitJobInput): Job {
    const claims = this.tokens.verify(token, { requiredScope: "job:create", orderId: input.orderId, leaseId: input.leaseId });
    const order = this.store.orders.get(input.orderId);
    const lease = this.store.leases.get(input.leaseId);
    if (!order || !lease) throw notFound("订单或租约");
    const listing = this.store.listings.get(order.listingId);
    if (!listing) throw notFound("算力商品");
    if (order.buyerId !== claims.subject) throw forbidden("token 所属用户不是订单买家");
    if (lease.orderId !== order.id || lease.tokenVersion !== claims.version) throw new DomainError("TOKEN_REVOKED", "租约 token 已撤销");
    if (!allowedStatuses.has(lease.status)) throw new DomainError("LEASE_NOT_READY", "租约当前不能提交任务");
    this.validateInput(input, listing.imageDigests);
    const job: Job = {
      id: id("job"),
      orderId: order.id,
      leaseId: lease.id,
      ownerId: claims.subject,
      imageDigest: input.imageDigest,
      command: [...input.command],
      inputArtifactIds: [...input.inputArtifactIds],
      status: "queued",
      maxRuntimeSeconds: input.maxRuntimeSeconds,
      createdAt: new Date(this.clock()).toISOString(),
      startedAt: null,
      endedAt: null,
      outputArtifactIds: [],
    };
    this.jobs.set(job.id, job);
    return job;
  }

  public get(token: string, jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("任务");
    this.authorizeJob(token, "job:read", job);
    return job;
  }

  public cancel(token: string, jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("任务");
    this.authorizeJob(token, "job:cancel", job);
    if (!["created", "queued", "running"].includes(job.status)) throw new DomainError("INVALID_JOB_STATE", "任务当前不能取消");
    job.status = "cancelled";
    job.endedAt = new Date(this.clock()).toISOString();
    return job;
  }

  public markRunning(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("任务");
    if (job.status !== "queued") throw new DomainError("INVALID_JOB_STATE", "只有排队中的任务可以运行");
    job.status = "running";
    job.startedAt = new Date(this.clock()).toISOString();
    return job;
  }

  public complete(jobId: string, outputArtifactIds: string[] = []): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("任务");
    if (job.status !== "running") throw new DomainError("INVALID_JOB_STATE", "只有运行中的任务可以完成");
    job.status = "succeeded";
    job.outputArtifactIds = [...outputArtifactIds];
    job.endedAt = new Date(this.clock()).toISOString();
    return job;
  }

  public fail(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw notFound("任务");
    if (!["queued", "running"].includes(job.status)) throw new DomainError("INVALID_JOB_STATE", "任务当前不能失败");
    job.status = "failed";
    job.endedAt = new Date(this.clock()).toISOString();
    return job;
  }

  private authorizeJob(token: string, scope: CapabilityScope, job: Job): void {
    const claims = this.tokens.verify(token, { requiredScope: scope, orderId: job.orderId, leaseId: job.leaseId });
    if (claims.subject !== job.ownerId) throw forbidden("token 所属用户不是任务所有者");
    const lease = this.store.leases.get(job.leaseId);
    if (!lease || lease.tokenVersion !== claims.version) throw new DomainError("TOKEN_REVOKED", "租约 token 已撤销");
  }

  private validateInput(input: SubmitJobInput, listingImages: readonly string[]): void {
    const allowedImages = listingImages.length > 0 ? listingImages : this.allowedImages;
    if (!allowedImages.includes(input.imageDigest)) throw new DomainError("IMAGE_NOT_ALLOWED", "任务镜像不在平台白名单中");
    if (input.command.length === 0 || input.command.length > 32 || input.command.some((part) => part.length === 0 || part.length > 256 || part.includes("\0"))) {
      throw new DomainError("COMMAND_INVALID", "任务入口命令不合法");
    }
    if (!Number.isInteger(input.maxRuntimeSeconds) || input.maxRuntimeSeconds < 1 || input.maxRuntimeSeconds > 7 * 24 * 60 * 60) {
      throw new DomainError("RUNTIME_LIMIT_INVALID", "任务最长运行时间不合法");
    }
    if (input.inputArtifactIds.length > 100) throw new DomainError("TOO_MANY_ARTIFACTS", "输入 artifact 数量超限");
  }
}

