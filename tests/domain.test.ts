import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

const fixture = () => {
  const service = new MarketplaceService(createStore());
  const buyer = service.createUser("buyer");
  const provider = service.createUser("provider");
  const operator = service.createUser("operator");
  const node = service.registerNode(provider.id, {
    region: "cn-east-1",
    agentVersion: "0.1.0",
    certificateFingerprint: "test-fingerprint",
    gpus: [{ uuid: "GPU-1", model: "RTX 5090", vramMb: 32_768, cudaVersion: "12.8", benchmarkScore: 210 }],
  });
  const gpu = node.gpus[0];
  if (!gpu) throw new Error("fixture GPU missing");
  const listing = service.createListing(provider.id, {
    nodeId: node.id,
    gpuId: gpu.id,
    pricePerHourMinor: 278,
    minimumMinutes: 30,
    imageDigests: ["sha256:" + "a".repeat(64)],
  });
  service.publishListing(operator.id, listing.id);
  return { service, buyer, provider, operator, node, gpu, listing };
};

describe("MarketplaceService", () => {
  it("按整数最小货币单位计算订单并记录审计事件", () => {
    const { service, buyer, listing } = fixture();
    const { order, payment } = service.createOrder(buyer.id, listing.id, 60);
    expect(order.computeAmountMinor).toBe(278);
    expect(order.platformFeeMinor).toBe(13);
    expect(order.totalAmountMinor).toBe(291);
    expect(payment.amountMinor).toBe(291);
    expect(service.auditEvents().length).toBeGreaterThan(0);
  });

  it("未支付不能分配租约，支付授权后只能独占一张 GPU", () => {
    const { service, buyer, listing } = fixture();
    const first = service.createOrder(buyer.id, listing.id, 30);
    expect(() => service.allocateLease(first.order.id)).toThrowError(DomainError);
    service.authorizePayment(first.payment.id, "sandbox-payment-1");
    const lease = service.allocateLease(first.order.id);
    expect(lease.status).toBe("requested");
    const secondBuyer = service.createUser("buyer");
    expect(() => service.createOrder(secondBuyer.id, listing.id, 30)).toThrowError(/GPU 当前不可用/);
  });

  it("买家不能读取其他买家的订单，卖家不能读取其他节点", () => {
    const { service, buyer, provider, listing, node } = fixture();
    const otherBuyer = service.createUser("buyer");
    const ownOrder = service.createOrder(buyer.id, listing.id, 30);
    expect(() => service.getOrderForBuyer(otherBuyer.id, ownOrder.order.id)).toThrowError(/其他买家/);
    const otherProvider = service.createUser("provider");
    expect(() => service.getNodeForProvider(otherProvider.id, node.id)).toThrowError(/其他卖家/);
    expect(service.getNodeForProvider(provider.id, node.id).id).toBe(node.id);
  });

  it("结束订单会释放 GPU、提升 token 版本并完成清理前置状态", () => {
    const { service, buyer, listing, gpu } = fixture();
    const { order, payment } = service.createOrder(buyer.id, listing.id, 30);
    service.authorizePayment(payment.id, "sandbox-payment");
    const lease = service.allocateLease(order.id);
    service.markLeaseReady(lease.id, "sandbox_1");
    const ended = service.endOrder(order.id);
    expect(ended.status).toBe("completed");
    expect(lease.status).toBe("ended");
    expect(lease.tokenVersion).toBe(2);
    expect(gpu.available).toBe(true);
  });

  it("拒绝无效镜像、无效价格和没有 GPU 的节点", () => {
    const service = new MarketplaceService(createStore());
    const provider = service.createUser("provider");
    expect(() => service.registerNode(provider.id, {
      region: "cn-east-1",
      agentVersion: "0.1.0",
      certificateFingerprint: "test",
      gpus: [],
    })).toThrowError(/至少需要一张 GPU/);
  });

  it("下单立即预留 GPU，预留过期后释放并标记未支付订单失败", () => {
    const { service, buyer, listing } = fixture();
    const first = service.createOrder(buyer.id, listing.id, 30);
    const secondBuyer = service.createUser("buyer");
    expect(() => service.createOrder(secondBuyer.id, listing.id, 30)).toThrowError(/临时预留/);
    expect(service.expireReservations(Date.now() + 16 * 60_000)).toBe(1);
    expect(service.store.orders.get(first.order.id)?.status).toBe("failed");
    expect(service.createOrder(secondBuyer.id, listing.id, 30).order.buyerId).toBe(secondBuyer.id);
  });
});

