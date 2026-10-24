import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

const digest = "sha256:" + "1".repeat(64);
const webhookSecret = "development-payment-webhook-secret-longer-than-32";

const sign = (event: unknown): string => createHmac("sha256", webhookSecret).update(JSON.stringify(event)).digest("hex");

describe("计量、支付 webhook 和结算 API", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("支付 webhook 验签并按 eventId 幂等处理", async () => {
    const service = new MarketplaceService(createStore());
    const app = createApp(service);
    apps.push(app);
    const buyer = service.createUser("buyer");
    const provider = service.createUser("provider");
    const operator = service.createUser("operator");
    const node = service.registerNode(provider.id, { region: "cn", agentVersion: "0.1", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-webhook", model: "RTX", vramMb: 1000, cudaVersion: "12", benchmarkScore: 1 }] });
    const listing = service.createListing(provider.id, { nodeId: node.id, gpuId: node.gpus[0]!.id, pricePerHourMinor: 100, minimumMinutes: 1, imageDigests: [digest] });
    service.publishListing(operator.id, listing.id);
    const created = service.createOrder(buyer.id, listing.id, 1);
    const event = { eventId: "evt-1", paymentId: created.payment.id, status: "authorized" as const, providerReference: "provider-ref" };
    const invalid = await app.inject({ method: "POST", url: "/v1/payments/webhooks/mock", payload: event, headers: { "x-webhook-signature": "bad" } });
    expect(invalid.statusCode).toBe(401);
    const first = await app.inject({ method: "POST", url: "/v1/payments/webhooks/mock", payload: event, headers: { "x-webhook-signature": sign(event) } });
    const duplicate = await app.inject({ method: "POST", url: "/v1/payments/webhooks/mock", payload: event, headers: { "x-webhook-signature": sign(event) } });
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(service.store.payments.get(created.payment.id)?.status).toBe("authorized");
    const reused = { ...event, status: "captured" as const };
    const reuseResponse = await app.inject({ method: "POST", url: "/v1/payments/webhooks/mock", payload: reused, headers: { "x-webhook-signature": sign(reused) } });
    expect(reuseResponse.statusCode).toBe(400);
  });

  it("Agent 只能为自己的 GPU 上报计量，订单结束后可由 operator 结算", async () => {
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);
    const user = async (role: "buyer" | "provider" | "operator") => (await app.inject({ method: "POST", url: "/v1/users", payload: { role } })).json<{ id: string }>();
    const buyer = await user("buyer");
    const provider = await user("provider");
    const operator = await user("operator");
    const node = (await app.inject({ method: "POST", url: "/v1/nodes", headers: { "x-user-id": provider.id }, payload: { region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-meter", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }] } })).json<{ id: string; gpus: [{ id: string; uuid: string }] }>();
    const listing = (await app.inject({ method: "POST", url: "/v1/listings", headers: { "x-user-id": provider.id }, payload: { nodeId: node.id, gpuId: node.gpus[0].id, pricePerHourMinor: 278, minimumMinutes: 1, imageDigests: [digest] } })).json<{ id: string }>();
    await app.inject({ method: "POST", url: `/v1/listings/${listing.id}/publish`, headers: { "x-user-id": operator.id } });
    const created = (await app.inject({ method: "POST", url: "/v1/orders", headers: { "x-user-id": buyer.id }, payload: { listingId: listing.id, durationMinutes: 1 } })).json<{ order: { id: string }; payment: { id: string } }>();
    await app.inject({ method: "POST", url: `/v1/payments/${created.payment.id}/authorize`, headers: { "x-user-id": operator.id }, payload: { providerReference: "meter-payment" } });
    const lease = (await app.inject({ method: "POST", url: `/v1/orders/${created.order.id}/lease`, headers: { "x-user-id": operator.id } })).json<{ id: string }>();
    await app.inject({ method: "POST", url: `/v1/leases/${lease.id}/ready`, headers: { "x-user-id": operator.id }, payload: { sandboxId: "meter-sandbox" } });
    const observedAtEpoch = Math.floor(Date.now() / 1000) - 1;
    const meter = await app.inject({ method: "POST", url: `/v1/agent/leases/${lease.id}/meter`, headers: { "x-user-id": provider.id }, payload: { observedAtEpoch, heartbeat: true, sandboxState: "running", gpuUuid: node.gpus[0].uuid } });
    expect(meter.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/agent/leases/${lease.id}/meter`, headers: { "x-user-id": buyer.id }, payload: { observedAtEpoch, heartbeat: true, sandboxState: "running", gpuUuid: node.gpus[0].uuid } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/v1/agent/leases/${lease.id}/meter`, headers: { "x-user-id": provider.id }, payload: { observedAtEpoch, heartbeat: true, sandboxState: "running", gpuUuid: "GPU-forged" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/v1/orders/${created.order.id}/metering`, headers: { "x-user-id": buyer.id } })).json<{ billableSeconds: number }>().billableSeconds).toBe(30);
    await app.inject({ method: "POST", url: `/v1/orders/${created.order.id}/end`, headers: { "x-user-id": buyer.id } });
    const settled = await app.inject({ method: "POST", url: `/v1/orders/${created.order.id}/settle`, headers: { "x-user-id": operator.id } });
    expect(settled.statusCode).toBe(200);
    expect(settled.json<{ status: string; billableSeconds: number }>()).toMatchObject({ status: "settled", billableSeconds: 30 });
    expect((await app.inject({ method: "POST", url: `/v1/orders/${created.order.id}/settle`, headers: { "x-user-id": buyer.id } })).statusCode).toBe(403);
  });
});
