import { describe, expect, it } from "vitest";
import { CapabilityTokenService } from "../src/agent/security.js";
import { InMemorySandboxRuntime, type SandboxSpec } from "../src/agent/sandbox.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";
import { ArtifactService } from "../src/workload/artifact.js";
import { OrderCleanupService } from "../src/workload/cleanup.js";
import { WorkloadService } from "../src/workload/job.js";

const digest = "sha256:" + "f".repeat(64);
const secret = "cleanup-test-secret-that-is-longer-than-32-characters";

describe("订单清理编排", () => {
  it("成功时先撤销访问、取消任务、销毁 sandbox 和 artifact，最后释放 GPU", () => {
    const store = createStore();
    const marketplace = new MarketplaceService(store);
    const buyer = marketplace.createUser("buyer");
    const provider = marketplace.createUser("provider");
    const operator = marketplace.createUser("operator");
    const node = marketplace.registerNode(provider.id, { region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-cleanup", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }] });
    const listing = marketplace.createListing(provider.id, { nodeId: node.id, gpuId: node.gpus[0]!.id, pricePerHourMinor: 278, minimumMinutes: 30, imageDigests: [digest] });
    marketplace.publishListing(operator.id, listing.id);
    const created = marketplace.createOrder(buyer.id, listing.id, 30);
    marketplace.authorizePayment(created.payment.id, "cleanup-payment");
    const lease = marketplace.allocateLease(created.order.id);
    marketplace.markLeaseReady(lease.id, "cleanup-sandbox");

    const tokens = new CapabilityTokenService(secret);
    const token = tokens.issue({ subject: buyer.id, orderId: created.order.id, leaseId: lease.id, scopes: ["job:create", "job:read", "artifact:read", "artifact:write"], version: lease.tokenVersion, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const artifacts = new ArtifactService(store, tokens);
    const artifact = artifacts.createInput(token, { orderId: created.order.id, leaseId: lease.id, displayName: "input.bin", sizeBytes: 10, sha256: "a".repeat(64) });
    artifacts.completeUpload(token, artifact.id);
    const workload = new WorkloadService(store, tokens, [], undefined, artifacts);
    const job = workload.submit(token, { orderId: created.order.id, leaseId: lease.id, imageDigest: digest, command: ["python"], inputArtifactIds: [artifact.id], maxRuntimeSeconds: 60 });
    expect(job.status).toBe("queued");
    const runtime = new InMemorySandboxRuntime([digest]);
    const spec: SandboxSpec = { sandboxId: lease.sandboxId!, leaseId: lease.id, gpuUuid: "GPU-cleanup", imageDigest: digest, command: ["python"], workspaceQuotaMb: 100, environment: {}, networkMode: "isolated", hostPid: false, hostIpc: false, hostNetwork: false, readOnlyRootFilesystem: true, privileged: false, hostMounts: [], dropCapabilities: ["ALL"], pidsLimit: 256, memoryLimitMb: 1024, cpuLimitMilli: 1000, containerUser: "1000", allowlistedEgress: [] };
    runtime.create(spec);
    runtime.start(spec.sandboxId);
    const cleanup = new OrderCleanupService(marketplace, workload, artifacts, runtime);
    const result = cleanup.endOrder(created.order.id);

    expect(result.report).toMatchObject({ cancelledJobs: 1, revokedTokens: true, sandboxDestroyed: true, deletedArtifacts: 1 });
    expect(result.order.status).toBe("completed");
    expect(store.leases.get(lease.id)?.status).toBe("ended");
    expect(store.nodes.get(node.id)?.gpus[0]?.available).toBe(true);
    expect(runtime.get(spec.sandboxId)?.status).toBe("destroyed");
    expect(artifacts.listForOrder(created.order.id)).toHaveLength(0);
    expect(() => artifacts.get(token, artifact.id)).toThrowError(/撤销/);
  });

  it("sandbox 清理失败时保留 ending 和 GPU 占用，允许后续重试", () => {
    const store = createStore();
    const marketplace = new MarketplaceService(store);
    const provider = marketplace.createUser("provider");
    const buyer = marketplace.createUser("buyer");
    const operator = marketplace.createUser("operator");
    const node = marketplace.registerNode(provider.id, { region: "cn", agentVersion: "0.1", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-failure", model: "RTX", vramMb: 1000, cudaVersion: "12", benchmarkScore: 1 }] });
    const listing = marketplace.createListing(provider.id, { nodeId: node.id, gpuId: node.gpus[0]!.id, pricePerHourMinor: 100, minimumMinutes: 1, imageDigests: [digest] });
    marketplace.publishListing(operator.id, listing.id);
    const created = marketplace.createOrder(buyer.id, listing.id, 1);
    marketplace.authorizePayment(created.payment.id, "failure-payment");
    const lease = marketplace.allocateLease(created.order.id);
    marketplace.markLeaseReady(lease.id, "missing-sandbox");
    const runtime = { get: () => ({ status: "running" }), stop: () => { throw new Error("agent offline"); }, destroy: () => undefined };
    const tokens = new CapabilityTokenService(secret);
    const artifacts = new ArtifactService(store, tokens);
    const workload = new WorkloadService(store, tokens, [], undefined, artifacts);
    const cleanup = new OrderCleanupService(marketplace, workload, artifacts, runtime);
    expect(() => cleanup.endOrder(created.order.id)).toThrowError(/清理失败/);
    expect(store.orders.get(created.order.id)?.status).toBe("ending");
    expect(store.leases.get(lease.id)?.status).toBe("cleanup_failed");
    expect(store.nodes.get(node.id)?.gpus[0]?.available).toBe(false);
  });
});
