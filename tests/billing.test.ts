import { describe, expect, it } from "vitest";
import { CapabilityTokenService } from "../src/agent/security.js";
import { MeteringService } from "../src/billing/metering.js";
import { SettlementService } from "../src/billing/settlement.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";
import { ArtifactService } from "../src/workload/artifact.js";

const secret = "billing-test-secret-that-is-longer-than-32-characters";
const imageDigest = "sha256:" + "e".repeat(64);

const fixture = () => {
  const store = createStore();
  const service = new MarketplaceService(store);
  const buyer = service.createUser("buyer");
  const provider = service.createUser("provider");
  const operator = service.createUser("operator");
  const node = service.registerNode(provider.id, { region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-1", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }] });
  const gpu = node.gpus[0];
  if (!gpu) throw new Error("fixture GPU missing");
  const listing = service.createListing(provider.id, { nodeId: node.id, gpuId: gpu.id, pricePerHourMinor: 278, minimumMinutes: 30, imageDigests: [imageDigest] });
  service.publishListing(operator.id, listing.id);
  const { order, payment } = service.createOrder(buyer.id, listing.id, 60);
  service.authorizePayment(payment.id, "pay-billing");
  const lease = service.allocateLease(order.id);
  service.markLeaseReady(lease.id, "sandbox-billing");
  const tokens = new CapabilityTokenService(secret);
  const token = tokens.issue({ subject: buyer.id, orderId: order.id, leaseId: lease.id, scopes: ["artifact:read", "artifact:write", "job:create"], version: lease.tokenVersion, expiresAt: Math.floor(Date.now() / 1000) + 3_600 });
  return { store, service, buyer, provider, operator, order, payment, lease, tokens, token };
};

describe("artifact、计量和结算", () => {
  it("artifact 使用服务端订单前缀，跨订单和租约结束后不可读", () => {
    const { store, service, order, lease, token, tokens, buyer } = fixture();
    const artifacts = new ArtifactService(store, tokens);
    const artifact = artifacts.createInput(token, { orderId: order.id, leaseId: lease.id, displayName: "dataset.zip", sizeBytes: 128, sha256: "a".repeat(64) });
    expect(artifact.objectKey).toBe(`orders/${order.id}/inputs/${artifact.id}`);
    expect(artifacts.completeUpload(token, artifact.id).status).toBe("available");
    expect(artifacts.get(token, artifact.id).ownerId).toBe(buyer.id);
    const other = service.createUser("buyer");
    const otherToken = tokens.issue({ subject: other.id, orderId: order.id, leaseId: lease.id, scopes: ["artifact:read"], version: lease.tokenVersion, expiresAt: Math.floor(Date.now() / 1000) + 3_600 });
    expect(() => artifacts.get(otherToken, artifact.id)).toThrowError(/其他买家/);
    service.endOrder(order.id);
    expect(() => artifacts.get(token, artifact.id)).toThrowError(/撤销/);
    expect(artifacts.deleteOrderArtifacts(order.id)).toBe(1);
  });

  it("计量按租约和时间桶幂等，故障心跳不计费", () => {
    const { store, lease } = fixture();
    const metering = new MeteringService(store, 30);
    const first = metering.record({ leaseId: lease.id, observedAtEpoch: 1_000, heartbeat: true, sandboxState: "running", gpuUuid: "GPU-1" });
    const duplicate = metering.record({ leaseId: lease.id, observedAtEpoch: 1_005, heartbeat: true, sandboxState: "running", gpuUuid: "GPU-1" });
    const second = metering.record({ leaseId: lease.id, observedAtEpoch: 1_030, heartbeat: true, sandboxState: "running", gpuUuid: "GPU-1" });
    const failed = metering.record({ leaseId: lease.id, observedAtEpoch: 1_060, heartbeat: false, sandboxState: "failed", gpuUuid: "GPU-1" });
    expect(duplicate.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(failed.billable).toBe(false);
    expect(metering.billableSeconds(lease.orderId)).toBe(60);
  });

  it("整小时结算保持买家费用、平台费与卖家应收守恒", () => {
    const {store,service,order,lease}=fixture();
    const metering=new MeteringService(store,30);
    for(let i=0;i<120;i++) metering.record({leaseId:lease.id,observedAtEpoch:2000+i*30,heartbeat:true,sandboxState:"running",gpuUuid:"GPU-1"});
    service.endOrder(order.id);
    const result=new SettlementService(store,metering).settle(order.id);
    expect(result).toMatchObject({computeAmountMinor:278,platformFeeMinor:13,providerPayoutMinor:278,chargedAmountMinor:291,releasedAmountMinor:0});
  });

  it("结算金额可以由计量重建，重复结算幂等，争议订单冻结", () => {
    const { store, service, order, lease, payment } = fixture();
    const metering = new MeteringService(store, 30);
    metering.record({ leaseId: lease.id, observedAtEpoch: 2_000, heartbeat: true, sandboxState: "ready", gpuUuid: "GPU-1" });
    metering.record({ leaseId: lease.id, observedAtEpoch: 2_030, heartbeat: true, sandboxState: "running", gpuUuid: "GPU-1" });
    service.endOrder(order.id);
    const settlement = new SettlementService(store, metering);
    const result = settlement.settle(order.id);
    expect(result.billableSeconds).toBe(60);
    expect(result.computeAmountMinor).toBe(5);
    expect(result.providerPayoutMinor).toBe(result.computeAmountMinor);
    expect(result.chargedAmountMinor).toBe(result.providerPayoutMinor + result.platformFeeMinor);
    expect(result.chargedAmountMinor + result.releasedAmountMinor).toBe(order.totalAmountMinor);
    expect(payment.status).toBe("settled");
    expect(settlement.settle(order.id).id).toBe(result.id);
    expect(settlement.getLedger()).toHaveLength(4);

    const secondOrder = service.createOrder(service.createUser("buyer").id, service.store.listings.values().next().value.id, 30);
    service.authorizePayment(secondOrder.payment.id, "pay-dispute");
    const secondLease = service.allocateLease(secondOrder.order.id);
    service.markLeaseReady(secondLease.id, "sandbox-dispute");
    service.endOrder(secondOrder.order.id);
    settlement.dispute(secondOrder.order.id);
    expect(() => settlement.settle(secondOrder.order.id)).toThrowError(/争议/);

    const frozen = settlement.settle(order.id);
    settlement.dispute(order.id);
    expect(frozen.status).toBe("frozen");
    expect(() => settlement.settle(order.id)).toThrowError(/争议/);
  });
});

