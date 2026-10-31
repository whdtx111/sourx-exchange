import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import { MarketplaceService } from "../domain/service.js";
import { CapabilityTokenService } from "../agent/security.js";
import { registerGatewayRoutes } from "./gateway.js";
import { WorkloadService } from "../workload/job.js";
import { ArtifactService } from "../workload/artifact.js";
import { OrderCleanupService } from "../workload/cleanup.js";
import { InMemorySandboxRuntime } from "../agent/sandbox.js";
import { MeteringService } from "../billing/metering.js";
import { SettlementService } from "../billing/settlement.js";
import { PaymentWebhookProcessor } from "../billing/payment-webhook.js";
import { AuthService } from "../auth/service.js";
import { AgentRegistry } from "../agent/registry.js";
import { EnrollmentCodeStore } from "../agent/enrollment.js";
import { AgentCommandQueue } from "../agent/commands.js";
import { AgentCommandSigner } from "../agent/security.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoImageDigest, initializeDemo } from "../demo.js";

import { PortalViews } from "../platform/views.js";
import { registerPortalRoutes } from "../platform/routes.js";
import { LocalPersistence, restoreDomain, snapshotDomain } from "../platform/persistence.js";

const userRoleSchema = z.object({ role: z.enum(["buyer", "provider", "operator"]) });
const nodeSchema = z.object({
  region: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(32),
  certificateFingerprint: z.string().min(16).max(128),
  gpus: z.array(z.object({
    uuid: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    vramMb: z.number().int().positive(),
    cudaVersion: z.string().min(1).max(32),
    benchmarkScore: z.number().nonnegative(),
  })).min(1),
});
const listingSchema = z.object({
  nodeId: z.string().min(1),
  gpuId: z.string().min(1),
  pricePerHourMinor: z.number().int().positive(),
  minimumMinutes: z.number().int().positive(),
  imageDigests: z.array(z.string()).min(1),
});
const orderSchema = z.object({
  listingId: z.string().min(1),
  durationMinutes: z.number().int().min(1).max(10080),
});
const paymentSchema = z.object({ providerReference: z.string().min(1).max(128) });
const readySchema = z.object({ sandboxId: z.string().min(1).max(128) });
const meterSchema = z.object({
  observedAtEpoch: z.number().int().positive(),
  heartbeat: z.boolean(),
  sandboxState: z.enum(["ready", "running", "failed", "stopped"]),
  gpuUuid: z.string().min(1).max(128),
});
const paymentWebhookSchema = z.object({
  eventId: z.string().min(1).max(128),
  paymentId: z.string().min(1),
  status: z.enum(["authorized", "captured", "failed", "voided"]),
  providerReference: z.string().min(1).max(128),
});
const authRegisterSchema = z.object({ identifier: z.string().min(3).max(254), password: z.string().min(12).max(256), role: z.enum(["buyer", "provider"]) });
const authLoginSchema = z.object({ identifier: z.string().min(3).max(254), password: z.string().min(1).max(256) });
const refreshSchema = z.object({ refreshToken: z.string().min(20) });
const agentEnrollSchema = z.object({
  code: z.string().min(6).max(128),
  region: z.string().min(1).max(64),
  agentVersion: z.string().min(1).max(32),
  certificateFingerprint: z.string().min(16).max(128),
  gpus: z.array(z.object({
    uuid: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    vramMb: z.number().int().positive(),
    cudaVersion: z.string().min(1).max(32),
    benchmarkScore: z.number().nonnegative(),
  })).min(1),
});
const agentHeartbeatSchema = z.object({ at: z.string().datetime().optional() });
const commandAckSchema = z.object({ status: z.enum(["succeeded", "failed"]), message: z.string().max(512).nullable().default(null) });

type ActorRequest = FastifyRequest<{ Body: unknown; Params: { id: string } }>;
type IdRequest = FastifyRequest<{ Params: { id: string } }>;
type CommandAckRequest = FastifyRequest<{ Body: unknown; Params: { id: string; commandId: string } }>;

const actorId = (request: FastifyRequest, auth: AuthService): string | null => {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return auth.verifyAccess(authorization.slice("Bearer ".length)).id;
  const devAuthBypass = process.env.NODE_ENV === "test" || process.env.ALLOW_DEV_AUTH_BYPASS === "true";
  if (!devAuthBypass) return null;
  const value = request.headers["x-user-id"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const routeId = (request: IdRequest): string => request.params.id;

const requireActor = (request: FastifyRequest, reply: FastifyReply, auth: AuthService): string | null => {
  let id: string | null;
  try {
    id = actorId(request, auth);
  } catch (error) {
    if (error instanceof DomainError) {
      void reply.code(error.code === "ACCOUNT_SUSPENDED" ? 403 : 401).send({ error: { code: error.code, message: error.message } });
      return null;
    }
    throw error;
  }
  if (!id) {
    void reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "请先登录" } });
    return null;
  }
  return id;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);

export const createApp = (service: MarketplaceService, options: {dataFile?: string} = {}): FastifyInstance => {
  const persistence = options.dataFile ? new LocalPersistence(options.dataFile) : null;
  restoreDomain(service.store, persistence?.read("domain"));
  const app = Fastify({ logger: false });
  const auth = new AuthService(service, process.env.AUTH_SECRET ?? "development-auth-secret-that-is-longer-than-32");
  const actor = (request: FastifyRequest, reply: FastifyReply): string | null => requireActor(request, reply, auth);
  const capabilityTokens = new CapabilityTokenService(process.env.CAPABILITY_SECRET ?? "development-secret-that-is-longer-than-32-characters");
  const artifacts = new ArtifactService(service.store, capabilityTokens);
  const workload = new WorkloadService(service.store, capabilityTokens, [], undefined, artifacts);
  const demoMode = process.env.DEMO_MODE === "true";
  const cleanupRuntime = new InMemorySandboxRuntime(demoMode ? [demoImageDigest] : []);
  const cleanup = new OrderCleanupService(service, workload, artifacts, cleanupRuntime);
  const metering = new MeteringService(service.store);
  const settlement = new SettlementService(service.store, metering);
  const paymentWebhooks = new PaymentWebhookProcessor(service, process.env.PAYMENT_WEBHOOK_SECRET ?? "development-payment-webhook-secret-longer-than-32");
  const enrollmentCodes = new EnrollmentCodeStore();
  const agentRegistry = new AgentRegistry(service, enrollmentCodes);
  const agentCommands = new AgentCommandQueue(new AgentCommandSigner(process.env.AGENT_COMMAND_SECRET ?? "development-agent-command-secret-longer-than-32"));
  agentRegistry.restore(persistence?.read("agents"));
  enrollmentCodes.restore(persistence?.read("enrollments"));
  agentCommands.restore(persistence?.read("commands"));
  paymentWebhooks.restore(persistence?.read("webhooks"));
  auth.restore(persistence?.read("auth"));
  workload.restore(persistence?.read("workload"));
  artifacts.restore(persistence?.read("artifacts"));
  metering.restore(persistence?.read("metering"));
  settlement.restore(persistence?.read("settlement"));
  cleanupRuntime.restore(persistence?.read("runtime"));
  if (demoMode) initializeDemo(service, metering, auth, settlement);
  const prepareRuntime = (leaseId: string) => {
    const lease = service.getLease(leaseId);
    const node = service.store.nodes.get(lease.nodeId)!;
    const sandboxId = lease.sandboxId ?? `sandbox_${lease.id}`;
    if (!cleanupRuntime.get(sandboxId)) cleanupRuntime.create({
      sandboxId, leaseId: lease.id, gpuUuid: node.gpus.find((g) => g.id === lease.gpuId)!.uuid,
      imageDigest: demoImageDigest, command: ["python"], workspaceQuotaMb: 1024, environment: {},
      networkMode: "isolated", hostPid: false, hostIpc: false, hostNetwork: false,
      readOnlyRootFilesystem: true, privileged: false, hostMounts: [], dropCapabilities: ["ALL"],
      pidsLimit: 128, memoryLimitMb: 4096, cpuLimitMilli: 2000, containerUser: "1000:1000", allowlistedEgress: [],
    });
    return sandboxId;
  };
  if (demoMode) for (const lease of service.store.leases.values()) {
    if (["ready", "running"].includes(lease.status)) prepareRuntime(lease.id);
  }
  const views = new PortalViews(service, metering, settlement);
  const persist = () => persistence?.save({agents:agentRegistry.snapshot(),enrollments:enrollmentCodes.snapshot(),commands:agentCommands.snapshot(),webhooks:paymentWebhooks.snapshot(),domain:snapshotDomain(service.store),auth:auth.snapshot(),workload:workload.snapshot(),artifacts:artifacts.snapshot(),metering:metering.snapshot(),settlement:settlement.snapshot(),runtime:cleanupRuntime.snapshot()});
  persist();
  app.addHook("onSend", async (request,_reply,payload) => { if (!["GET","HEAD"].includes(request.method)) persist(); return payload; });
  app.addHook("onClose", async () => { persist(); });
  registerPortalRoutes(app, {service,auth,views,workload,settlement,actor,localMode:demoMode,
    startLocalLease: (orderId) => {
      let lease = service.findLeaseForOrder(orderId);
      if (!lease) lease = service.allocateLease(orderId);
      if (["requested","starting"].includes(lease.status)) service.markLeaseReady(lease.id,prepareRuntime(lease.id));
    },
  });
  if (demoMode) {
    const localWorker = setInterval(() => {
      for (const lease of service.store.leases.values()) {
        if (!["ready","running"].includes(lease.status)) continue;
        const order = service.store.orders.get(lease.orderId)!;
        if (order.status !== "active") continue;
        if (lease.startedAt && Date.now() >= Date.parse(lease.startedAt) + order.durationMinutes * 60000) {
          cleanup.endOrder(order.id);
          settlement.settle(order.id);
          continue;
        }
        const node = service.store.nodes.get(lease.nodeId)!;
        if (node.agentVersion !== "1.0.0-local") continue;
        node.lastHeartbeatAt = new Date().toISOString();
        metering.record({leaseId:lease.id,observedAtEpoch:Math.floor(Date.now()/1000),heartbeat:true,sandboxState:"running",gpuUuid:node.gpus.find((g) => g.id === lease.gpuId)!.uuid});
      }
      persist();
    }, 30000);
    localWorker.unref();
    app.addHook("onClose", async () => {clearInterval(localWorker);});
  }
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const webDist = join(projectRoot, "web-dist");
  const sendWebFile = async (file: string, reply: FastifyReply, contentType: string) => {
    const content = await readFile(file);
    return reply.type(contentType).send(content);
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "CLEANUP_FAILED" ? 409 : error.code === "INVALID_WEBHOOK_SIGNATURE" ? 401 : 400;
      void reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof z.ZodError) {
      void reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "请求参数不合法",
          details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
      });
      return;
    }
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return void reply.code(error.statusCode).send({error:{code:"INVALID_REQUEST",message:error.message}});
    }
    console.error("[sourx] unhandled request error", error);
    void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "服务内部错误" } });
  });

  app.get("/health", async () => ({ status: "ok", service: "sourx-exchange" }));

  const serveApp = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control","no-cache");
    try { return await sendWebFile(join(webDist,"index.html"),reply,"text/html; charset=utf-8"); }
    catch { return reply.code(503).send({error:{code:"FRONTEND_NOT_BUILT",message:"请先执行 pnpm build 或启动前端开发服务"}}); }
  };
  app.get("/", serveApp);
  app.get("/login", serveApp);
  app.get("/buyer/*", serveApp);
  app.get("/seller/*", serveApp);
  app.get("/operator/*", serveApp);
  app.get("/assets/*", async (request, reply) => {
    const asset = (request.params as {"*":string})["*"];
    if (!asset || asset.includes("..") || asset.includes("\\")) return reply.code(404).send();
    const type = asset.endsWith(".css") ? "text/css; charset=utf-8" : asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
    try { reply.header("Cache-Control","public, max-age=31536000, immutable"); return await sendWebFile(join(webDist,"assets",asset),reply,type); }
    catch { return reply.header("Cache-Control","no-cache").type("application/json").code(404).send({error:{code:"NOT_FOUND",message:"静态资源不存在"}}); }
  });

  // 仅用于开发/测试环境的用户 bootstrap；正式环境应由身份服务替代。
  app.post("/v1/users", async (request, reply) => {
    if (!(process.env.NODE_ENV === "test" || process.env.ALLOW_DEV_AUTH_BYPASS === "true")) {
      return reply.code(403).send({ error: { code: "BOOTSTRAP_DISABLED", message: "生产环境已关闭用户 bootstrap" } });
    }
    const input = parse(userRoleSchema, request.body);
    const user = service.createUser(input.role);
    return reply.code(201).send(user);
  });

  app.post("/v1/auth/register", async (request, reply) => {
    const input = parse(authRegisterSchema, request.body);
    return reply.code(201).send(auth.register(input.identifier, input.password, input.role));
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const input = parse(authLoginSchema, request.body);
    return reply.send(auth.login(input.identifier, input.password));
  });

  app.post("/v1/auth/refresh", async (request, reply) => {
    const input = parse(refreshSchema, request.body);
    return reply.send(auth.refresh(input.refreshToken));
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) auth.logout(authorization.slice("Bearer ".length));
    return reply.code(204).send();
  });

  app.post("/v1/agent/enrollment-codes", async (request, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    return reply.code(201).send({ code: agentRegistry.issueEnrollmentCode(actorId) });
  });

  app.post("/v1/agent/enroll", async (request, reply) => {
    const input = parse(agentEnrollSchema, request.body);
    return reply.code(201).send(agentRegistry.enroll(input.code, input));
  });

  app.post("/v1/agent/nodes/:id/heartbeat", async (request: IdRequest, reply) => {
    const agentToken = request.headers["x-agent-token"];
    if (typeof agentToken !== "string" || agentToken.length === 0) throw new DomainError("INVALID_AGENT_CREDENTIAL", "缺少 Agent 凭证");
    const input = parse(agentHeartbeatSchema, request.body ?? {});
    return reply.send(agentRegistry.heartbeat(agentToken, routeId(request), input.at));
  });

  app.get("/v1/agent/nodes/:id/commands", async (request: IdRequest, reply) => {
    const agentToken = request.headers["x-agent-token"];
    if (typeof agentToken !== "string" || agentToken.length === 0) throw new DomainError("INVALID_AGENT_CREDENTIAL", "缺少 Agent 凭证");
    agentRegistry.assertNode(agentToken, routeId(request));
    return reply.send({ commands: agentCommands.pull(routeId(request)) });
  });

  app.post("/v1/agent/nodes/:id/commands/:commandId/ack", async (request: CommandAckRequest, reply) => {
    const agentToken = request.headers["x-agent-token"];
    if (typeof agentToken !== "string" || agentToken.length === 0) throw new DomainError("INVALID_AGENT_CREDENTIAL", "缺少 Agent 凭证");
    agentRegistry.assertNode(agentToken, request.params.id);
    const input = parse(commandAckSchema, request.body);
    return reply.send(agentCommands.acknowledge(request.params.id, request.params.commandId, input.status, input.message));
  });

  app.post("/v1/nodes", async (request, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const node = service.registerNode(actorId, parse(nodeSchema, request.body));
    return reply.code(201).send(node);
  });

  app.post("/v1/nodes/:id/heartbeat", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    return reply.send(service.heartbeat(actorId, routeId(request)));
  });

  app.post("/v1/listings", async (request, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const listing = service.createListing(actorId, parse(listingSchema, request.body));
    return reply.code(201).send(listing);
  });

  app.post("/v1/listings/:id/publish", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    return reply.send(service.publishListing(actorId, routeId(request)));
  });

  app.get("/v1/listings", async () => service.getVisibleListings());

  app.post("/v1/orders", async (request, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const result = service.createOrder(actorId, parse(orderSchema, request.body).listingId, parse(orderSchema, request.body).durationMinutes);
    return reply.code(201).send(result);
  });

  app.post("/v1/payments/:id/authorize", async (request: ActorRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    service.requireUser(actorId, "operator");
    return reply.send(service.authorizePayment(routeId(request), parse(paymentSchema, request.body).providerReference));
  });

  app.post("/v1/payments/webhooks/:provider", async (request, reply) => {
    const event = parse(paymentWebhookSchema, request.body);
    const signature = request.headers["x-webhook-signature"];
    if (typeof signature !== "string") throw new DomainError("INVALID_WEBHOOK_SIGNATURE", "缺少支付 webhook 签名");
    return reply.send(paymentWebhooks.handle(event, signature));
  });

  app.post("/v1/orders/:id/lease", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    service.requireUser(actorId, "operator");
    return reply.code(201).send(service.allocateLease(routeId(request)));
  });

  app.post("/v1/leases/:id/ready", async (request: ActorRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    service.requireUser(actorId, "operator");
    return reply.send(service.markLeaseReady(routeId(request), parse(readySchema, request.body).sandboxId));
  });

  app.post("/v1/agent/leases/:id/meter", async (request: ActorRequest, reply) => {
    const agentToken = request.headers["x-agent-token"];
    let lease;
    if (typeof agentToken === "string" && agentToken.length > 0) {
      lease = service.getLease(routeId(request));
      const node = service.store.nodes.get(lease.nodeId);
      if (!node) throw new DomainError("NOT_FOUND", "节点");
      agentRegistry.assertNode(agentToken, node.id);
    } else {
      const actorId = actor(request, reply);
      if (!actorId) return;
      lease = service.getLeaseForProvider(actorId, routeId(request));
    }
    return reply.send(metering.record({ leaseId: lease.id, ...parse(meterSchema, request.body) }));
  });

  app.get("/v1/orders/:id/capability", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const order = service.getOrderForBuyer(actorId, routeId(request));
    const lease = service.getLeaseForOrder(order.id);
    if (!["ready", "running"].includes(lease.status)) {
      throw new DomainError("LEASE_NOT_READY", "租约当前不能签发 capability token");
    }
    if (order.status !== "active") throw new DomainError("LEASE_NOT_READY", "订单当前不能提交任务");
    const leaseEnd = Math.floor(Date.parse(lease.startedAt!) / 1000) + order.durationMinutes * 60;
    const expiresAt = Math.min(Math.floor(Date.now() / 1000) + 900, leaseEnd);
    if (expiresAt <= Math.floor(Date.now() / 1000)) throw new DomainError("LEASE_EXPIRED", "租约已到期");
    const token = capabilityTokens.issue({
      subject: actorId,
      orderId: order.id,
      leaseId: lease.id,
      scopes: ["job:create", "job:read", "job:cancel", "artifact:read", "artifact:write"],
      version: lease.tokenVersion,
      expiresAt,
    });
    return reply.send({ token, expiresAt, orderId: order.id, leaseId: lease.id });
  });

  app.get("/v1/orders/:id", async (request: ActorRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    return reply.send(service.getOrderForBuyer(actorId, routeId(request)));
  });

  app.post("/v1/orders/:id/end", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const order = service.getOrderForBuyer(actorId, routeId(request));
    if (order.status === "completed") return reply.send({...order, settlement:settlement.getForOrder(order.id)});
    const result = cleanup.endOrder(order.id);
    const settled = demoMode ? settlement.settle(order.id) : null;
    return reply.send({ ...result.order, cleanup: result.report, settlement:settled });
  });

  app.get("/v1/orders/:id/metering", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const order = service.getOrderForBuyer(actorId, routeId(request));
    const buckets = metering.listForOrder(order.id);
    return reply.send({ orderId: order.id, billableSeconds: metering.billableSeconds(order.id), buckets });
  });

  app.post("/v1/orders/:id/dispute", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    const order = service.getOrderForBuyer(actorId, routeId(request));
    return reply.send(settlement.dispute(order.id));
  });

  app.post("/v1/orders/:id/settle", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    service.requireUser(actorId, "operator");
    return reply.send(settlement.settle(routeId(request)));
  });

  app.post("/v1/orders/:id/refund", async (request: IdRequest, reply) => {
    const actorId = actor(request, reply);
    if (!actorId) return;
    service.requireUser(actorId, "operator");
    return reply.send(settlement.refund(routeId(request)));
  });

  registerGatewayRoutes(app, workload, artifacts);

  return app;
};

