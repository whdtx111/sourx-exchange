import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

const digest = "sha256:" + "b".repeat(64);

describe("HTTP control plane", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("完成用户、节点、商品、支付、租约和订单结束闭环", async () => {
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);
    const user = async (role: "buyer" | "provider" | "operator") => {
      const response = await app.inject({ method: "POST", url: "/v1/users", payload: { role } });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>();
    };
    const buyer = await user("buyer");
    const provider = await user("provider");
    const operator = await user("operator");
    const nodeResponse = await app.inject({
      method: "POST",
      url: "/v1/nodes",
      headers: { "x-user-id": provider.id },
      payload: {
        region: "cn-east-1",
        agentVersion: "0.1.0",
        certificateFingerprint: "fingerprint-1234567890",
        gpus: [{ uuid: "GPU-1", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }],
      },
    });
    expect(nodeResponse.statusCode).toBe(201);
    const node = nodeResponse.json<{ id: string; gpus: [{ id: string }] }>();
    const listingResponse = await app.inject({
      method: "POST",
      url: "/v1/listings",
      headers: { "x-user-id": provider.id },
      payload: { nodeId: node.id, gpuId: node.gpus[0].id, pricePerHourMinor: 278, minimumMinutes: 30, imageDigests: [digest] },
    });
    const listing = listingResponse.json<{ id: string }>();
    expect((await app.inject({ method: "POST", url: `/v1/listings/${listing.id}/publish`, headers: { "x-user-id": operator.id } })).statusCode).toBe(200);
    const orderResponse = await app.inject({ method: "POST", url: "/v1/orders", headers: { "x-user-id": buyer.id }, payload: { listingId: listing.id, durationMinutes: 60 } });
    expect(orderResponse.statusCode).toBe(201);
    const orderResult = orderResponse.json<{ order: { id: string }; payment: { id: string } }>();
    expect((await app.inject({ method: "POST", url: `/v1/payments/${orderResult.payment.id}/authorize`, headers: { "x-user-id": operator.id }, payload: { providerReference: "payment-1" } })).statusCode).toBe(200);
    const leaseResponse = await app.inject({ method: "POST", url: `/v1/orders/${orderResult.order.id}/lease`, headers: { "x-user-id": operator.id } });
    expect(leaseResponse.statusCode).toBe(201);
    const lease = leaseResponse.json<{ id: string }>();
    expect((await app.inject({ method: "POST", url: `/v1/leases/${lease.id}/ready`, headers: { "x-user-id": operator.id }, payload: { sandboxId: "sandbox-1" } })).statusCode).toBe(200);
    const endResponse = await app.inject({ method: "POST", url: `/v1/orders/${orderResult.order.id}/end`, headers: { "x-user-id": buyer.id } });
    expect(endResponse.statusCode).toBe(200);
    expect(endResponse.json<{ status: string }>().status).toBe("completed");
  });

  it("签发租约 capability 后才能提交任务，订单结束后 token 失效", async () => {
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);
    const createUser = async (role: "buyer" | "provider" | "operator") => (await app.inject({ method: "POST", url: "/v1/users", payload: { role } })).json<{ id: string }>();
    const buyer = await createUser("buyer");
    const provider = await createUser("provider");
    const operator = await createUser("operator");
    const node = (await app.inject({ method: "POST", url: "/v1/nodes", headers: { "x-user-id": provider.id }, payload: { region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-1", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }] } })).json<{ id: string; gpus: [{ id: string }] }>();
    const listing = (await app.inject({ method: "POST", url: "/v1/listings", headers: { "x-user-id": provider.id }, payload: { nodeId: node.id, gpuId: node.gpus[0].id, pricePerHourMinor: 278, minimumMinutes: 30, imageDigests: [digest] } })).json<{ id: string }>();
    await app.inject({ method: "POST", url: `/v1/listings/${listing.id}/publish`, headers: { "x-user-id": operator.id } });
    const orderResult = (await app.inject({ method: "POST", url: "/v1/orders", headers: { "x-user-id": buyer.id }, payload: { listingId: listing.id, durationMinutes: 30 } })).json<{ order: { id: string }; payment: { id: string } }>();
    await app.inject({ method: "POST", url: `/v1/payments/${orderResult.payment.id}/authorize`, headers: { "x-user-id": operator.id }, payload: { providerReference: "payment-2" } });
    const lease = (await app.inject({ method: "POST", url: `/v1/orders/${orderResult.order.id}/lease`, headers: { "x-user-id": operator.id } })).json<{ id: string }>();
    await app.inject({ method: "POST", url: `/v1/leases/${lease.id}/ready`, headers: { "x-user-id": operator.id }, payload: { sandboxId: "sandbox-2" } });
    const capability = (await app.inject({ method: "GET", url: `/v1/orders/${orderResult.order.id}/capability`, headers: { "x-user-id": buyer.id } })).json<{ token: string }>();
    const job = await app.inject({ method: "POST", url: "/v1/gateway/jobs", headers: { authorization: `Bearer ${capability.token}` }, payload: { orderId: orderResult.order.id, leaseId: lease.id, imageDigest: digest, command: ["python", "/workspace/main.py"], inputArtifactIds: [], maxRuntimeSeconds: 60 } });
    expect(job.statusCode).toBe(201);
    const jobResult = job.json<{ id: string }>();
    expect((await app.inject({ method: "GET", url: `/v1/gateway/jobs/${jobResult.id}`, headers: { authorization: `Bearer ${capability.token}` } })).statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/v1/orders/${orderResult.order.id}/end`, headers: { "x-user-id": buyer.id } });
    expect((await app.inject({ method: "POST", url: "/v1/gateway/jobs", headers: { authorization: `Bearer ${capability.token}` }, payload: { orderId: orderResult.order.id, leaseId: lease.id, imageDigest: digest, command: ["python"], inputArtifactIds: [], maxRuntimeSeconds: 60 } })).statusCode).toBe(400);
  });

  it("拒绝未认证和跨买家订单读取", async () => {
    const service = new MarketplaceService(createStore());
    const app = createApp(service);
    apps.push(app);
    const unauthorized = await app.inject({ method: "POST", url: "/v1/nodes", payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    const buyer = service.createUser("buyer");
    const otherBuyer = service.createUser("buyer");
    const order = service.createUser("operator");
    expect(order.role).toBe("operator");
    const missing = await app.inject({ method: "GET", url: "/v1/orders/ord_missing", headers: { "x-user-id": buyer.id } });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/orders/ord_missing", headers: { "x-user-id": otherBuyer.id } })).statusCode).toBe(404);
  });

  it("拒绝买家直接授权支付和分配租约", async () => {
    const service = new MarketplaceService(createStore());
    const buyer = service.createUser("buyer");
    const app = createApp(service);
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/payments/pay_missing/authorize", headers: { "x-user-id": buyer.id }, payload: { providerReference: "payment" } });
    expect(response.statusCode).toBe(403);
  });
});

