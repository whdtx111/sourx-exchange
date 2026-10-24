import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

describe("Agent 注册与心跳 API", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("enrollment code 绑定卖家且 Agent 凭证不能访问其他节点", async () => {
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);
    const provider = (await app.inject({ method: "POST", url: "/v1/users", payload: { role: "provider" } })).json<{ id: string }>();
    const issue = await app.inject({ method: "POST", url: "/v1/agent/enrollment-codes", headers: { "x-user-id": provider.id } });
    expect(issue.statusCode).toBe(201);
    const code = issue.json<{ code: string }>().code;
    const nodeInput = { code, region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-agent-1", model: "RTX 5090", vramMb: 32768, cudaVersion: "12.8", benchmarkScore: 210 }] };
    const enrolled = await app.inject({ method: "POST", url: "/v1/agent/enroll", payload: nodeInput });
    expect(enrolled.statusCode).toBe(201);
    const first = enrolled.json<{ node: { id: string }; agentToken: string }>();
    expect((await app.inject({ method: "POST", url: `/v1/agent/enroll`, payload: nodeInput })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/v1/agent/nodes/${first.node.id}/heartbeat`, headers: { "x-agent-token": first.agentToken }, payload: {} })).statusCode).toBe(200);

    const secondCode = (await app.inject({ method: "POST", url: "/v1/agent/enrollment-codes", headers: { "x-user-id": provider.id } })).json<{ code: string }>().code;
    const second = (await app.inject({ method: "POST", url: "/v1/agent/enroll", payload: { ...nodeInput, code: secondCode, gpus: [{ ...nodeInput.gpus[0], uuid: "GPU-agent-2" }] } })).json<{ node: { id: string } }>();
    const denied = await app.inject({ method: "POST", url: `/v1/agent/nodes/${second.node.id}/heartbeat`, headers: { "x-agent-token": first.agentToken }, payload: {} });
    expect(denied.statusCode).toBe(400);
  });
});
