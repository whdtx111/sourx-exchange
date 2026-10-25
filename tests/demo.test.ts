import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

describe("local demo", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];
  const previousDemoMode = process.env.DEMO_MODE;
  const previousAuthBypass = process.env.ALLOW_DEV_AUTH_BYPASS;

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousDemoMode;
    if (previousAuthBypass === undefined) delete process.env.ALLOW_DEV_AUTH_BYPASS;
    else process.env.ALLOW_DEV_AUTH_BYPASS = previousAuthBypass;
  });

  it("serves the UI and a ready, order-scoped demo workload", async () => {
    process.env.DEMO_MODE = "true";
    process.env.ALLOW_DEV_AUTH_BYPASS = "true";
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);

    const [page, script, styles, overviewResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/" }),
      app.inject({ method: "GET", url: "/app.js" }),
      app.inject({ method: "GET", url: "/styles.css" }),
      app.inject({ method: "GET", url: "/v1/demo/overview" }),
    ]);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("SourX Exchange");
    expect(script.statusCode).toBe(200);
    expect(styles.statusCode).toBe(200);
    expect(overviewResponse.statusCode).toBe(200);
    const overview = overviewResponse.json<{ users: { buyer: { id: string }; operator: { id: string } }; order: { id: string }; lease: { id: string; status: string }; listing: { imageDigests: string[] } }>();
    expect(overview.lease.status).toBe("ready");

    const capabilityResponse = await app.inject({ method: "GET", url: `/v1/orders/${overview.order.id}/capability`, headers: { "x-user-id": overview.users.buyer.id } });
    expect(capabilityResponse.statusCode).toBe(200);
    const capability = capabilityResponse.json<{ token: string }>();
    const jobResponse = await app.inject({
      method: "POST",
      url: "/v1/gateway/jobs",
      headers: { authorization: `Bearer ${capability.token}` },
      payload: { orderId: overview.order.id, leaseId: overview.lease.id, imageDigest: overview.listing.imageDigests[0], command: ["python", "-c", "print('demo')"], inputArtifactIds: [], maxRuntimeSeconds: 120 },
    });
    expect(jobResponse.statusCode).toBe(201);
    expect(jobResponse.json<{ orderId: string }>().orderId).toBe(overview.order.id);

    const ended = await app.inject({ method: "POST", url: `/v1/orders/${overview.order.id}/end`, headers: { "x-user-id": overview.users.buyer.id } });
    expect(ended.statusCode).toBe(200);
    expect(ended.json<{ cleanup: { sandboxDestroyed: boolean } }>().cleanup.sandboxDestroyed).toBe(true);
    const settled = await app.inject({ method: "POST", url: `/v1/orders/${overview.order.id}/settle`, headers: { "x-user-id": overview.users.operator.id } });
    expect(settled.statusCode).toBe(200);
    expect(settled.json<{ status: string; providerPayoutMinor: number }>().status).toBe("settled");
    const revoked = await app.inject({ method: "POST", url: "/v1/gateway/jobs", headers: { authorization: `Bearer ${capability.token}` }, payload: { orderId: overview.order.id, leaseId: overview.lease.id, imageDigest: overview.listing.imageDigests[0], command: ["python"], inputArtifactIds: [], maxRuntimeSeconds: 120 } });
    expect(revoked.statusCode).toBe(400);
  });
});
