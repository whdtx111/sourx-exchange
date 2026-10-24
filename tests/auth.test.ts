import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { AuthService } from "../src/auth/service.js";
import { MarketplaceService } from "../src/domain/service.js";
import { createStore } from "../src/domain/store.js";

const password = "correct-horse-battery";

describe("身份认证与会话", () => {
  const apps: Awaited<ReturnType<typeof createApp>>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("注册、登录、refresh 轮换和登出会话", async () => {
    const app = createApp(new MarketplaceService(createStore()));
    apps.push(app);
    const registered = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { identifier: "Provider@Example.com", password, role: "provider" } });
    expect(registered.statusCode).toBe(201);
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: "provider@example.com", password } });
    expect(login.statusCode).toBe(200);
    const tokens = login.json<{ accessToken: string; refreshToken: string }>();
    const node = await app.inject({
      method: "POST",
      url: "/v1/nodes",
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      payload: { region: "cn-east-1", agentVersion: "0.1.0", certificateFingerprint: "fingerprint-1234567890", gpus: [{ uuid: "GPU-auth", model: "RTX", vramMb: 1024, cudaVersion: "12", benchmarkScore: 1 }] },
    });
    expect(node.statusCode).toBe(201);
    const refreshed = await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: tokens.refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    const next = refreshed.json<{ accessToken: string; refreshToken: string }>();
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect((await app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: tokens.refreshToken } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: { authorization: `Bearer ${next.accessToken}` } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/nodes", headers: { authorization: `Bearer ${next.accessToken}` }, payload: {} })).statusCode).toBe(401);
  });

  it("账户停用后 access token 立即失效，operator 不能通过公开注册创建", () => {
    const marketplace = new MarketplaceService(createStore());
    const auth = new AuthService(marketplace, "auth-test-secret-that-is-longer-than-32-characters");
    const user = auth.register("buyer@example.com", password, "buyer");
    const tokens = auth.login("buyer@example.com", password);
    const operator = marketplace.createUser("operator");
    marketplace.suspendUser(operator.id, user.id);
    expect(() => auth.verifyAccess(tokens.accessToken)).toThrowError(/停用/);
  });
});
