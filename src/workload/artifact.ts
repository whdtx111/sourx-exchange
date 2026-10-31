import { randomUUID } from "node:crypto";
import { DomainError, forbidden, notFound } from "../domain/errors.js";
import type { DomainStore } from "../domain/store.js";
import { CapabilityTokenService } from "../agent/security.js";

export type ArtifactKind = "input" | "output" | "log";
export type ArtifactStatus = "pending_upload" | "available" | "deleted";

export interface Artifact {
  id: string;
  orderId: string;
  leaseId: string;
  ownerId: string;
  kind: ArtifactKind;
  displayName: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  status: ArtifactStatus;
  createdAt: string;
  deletedAt: string | null;
}

export interface CreateArtifactInput {
  orderId: string;
  leaseId: string;
  displayName: string;
  sizeBytes: number;
  sha256: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

export class ArtifactService {
  private readonly artifacts = new Map<string, Artifact>();

  public snapshot() { return {artifacts: [...this.artifacts.entries()]}; }
  public restore(data: ReturnType<ArtifactService["snapshot"]> | undefined) {
    if (!data) return;
    for (const [key,value] of data.artifacts) this.artifacts.set(key,value);
  }

  public constructor(
    private readonly store: DomainStore,
    private readonly tokens: CapabilityTokenService,
    private readonly maxBytes = 1024 * 1024 * 1024,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public createInput(token: string, input: CreateArtifactInput): Artifact & { uploadUrl: string } {
    const claims = this.tokens.verify(token, { requiredScope: "artifact:write", orderId: input.orderId, leaseId: input.leaseId });
    this.assertLeaseOwner(input.orderId, input.leaseId, claims.subject, claims.version);
    if (!input.displayName || input.displayName.length > 128 || /[\\/\0]/.test(input.displayName)) throw new DomainError("ARTIFACT_NAME_INVALID", "artifact 名称不合法");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > this.maxBytes) throw new DomainError("ARTIFACT_SIZE_INVALID", "artifact 大小超出限制");
    if (!sha256Pattern.test(input.sha256)) throw new DomainError("ARTIFACT_HASH_INVALID", "artifact 必须提供 sha256");
    const id = `art_${randomUUID()}`;
    const artifact: Artifact = {
      id,
      orderId: input.orderId,
      leaseId: input.leaseId,
      ownerId: claims.subject,
      kind: "input",
      displayName: input.displayName,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      objectKey: `orders/${input.orderId}/inputs/${id}`,
      status: "pending_upload",
      createdAt: new Date(this.clock()).toISOString(),
      deletedAt: null,
    };
    this.artifacts.set(id, artifact);
    return { ...artifact, uploadUrl: `memory://upload/${id}` };
  }

  public completeUpload(token: string, artifactId: string): Artifact {
    const artifact = this.require(artifactId);
    const lease = this.store.leases.get(artifact.leaseId);
    if (!lease) throw notFound("租约");
    const claims = this.tokens.verify(token, { requiredScope: "artifact:write", orderId: artifact.orderId, leaseId: artifact.leaseId, expectedVersion: lease.tokenVersion });
    if (claims.subject !== artifact.ownerId) throw forbidden("不能操作其他买家的 artifact");
    if (artifact.status !== "pending_upload") throw new DomainError("INVALID_ARTIFACT_STATE", "artifact 当前不能完成上传");
    artifact.status = "available";
    return artifact;
  }

  public get(token: string, artifactId: string): Artifact {
    const artifact = this.require(artifactId);
    const lease = this.store.leases.get(artifact.leaseId);
    if (!lease) throw notFound("租约");
    const claims = this.tokens.verify(token, { requiredScope: "artifact:read", orderId: artifact.orderId, leaseId: artifact.leaseId, expectedVersion: lease.tokenVersion });
    if (claims.subject !== artifact.ownerId) throw forbidden("不能读取其他买家的 artifact");
    if (artifact.status === "deleted") throw notFound("artifact");
    return artifact;
  }

  public assertInput(token: string, artifactId: string, orderId: string, leaseId: string): Artifact {
    const artifact = this.get(token, artifactId);
    if (artifact.orderId !== orderId || artifact.leaseId !== leaseId || artifact.kind !== "input" || artifact.status !== "available") {
      throw new DomainError("ARTIFACT_RESOURCE_DENIED", "artifact 不属于当前订单或尚未可用");
    }
    return artifact;
  }

  public deleteOrderArtifacts(orderId: string): number {
    let deleted = 0;
    for (const artifact of this.artifacts.values()) {
      if (artifact.orderId === orderId && artifact.status !== "deleted") {
        artifact.status = "deleted";
        artifact.deletedAt = new Date(this.clock()).toISOString();
        deleted += 1;
      }
    }
    return deleted;
  }

  public listForOrder(orderId: string): Artifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.orderId === orderId && artifact.status !== "deleted");
  }

  private require(artifactId: string): Artifact {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw notFound("artifact");
    return artifact;
  }

  private assertLeaseOwner(orderId: string, leaseId: string, ownerId: string, tokenVersion: number): void {
    const order = this.store.orders.get(orderId);
    const lease = this.store.leases.get(leaseId);
    if (!order || !lease) throw notFound("订单或租约");
    if (order.buyerId !== ownerId) throw forbidden("token 所属用户不是订单买家");
    if (lease.orderId !== orderId || lease.tokenVersion !== tokenVersion || !["ready", "running"].includes(lease.status)) throw new DomainError("TOKEN_REVOKED", "租约 token 已撤销或租约不可用");
  }
}

