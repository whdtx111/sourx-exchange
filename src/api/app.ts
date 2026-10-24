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
  durationMinutes: z.number().int().positive(),
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

type ActorRequest = FastifyRequest<{ Body: unknown; Params: { id: string } }>;
type IdRequest = FastifyRequest<{ Params: { id: string } }>;

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
    void reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "缺少 x-user-id" } });
    return null;
  }
  return id;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);

export const createApp = (service: MarketplaceService): FastifyInstance => {
  const app = Fastify({ logger: false });
  const auth = new AuthService(service, process.env.AUTH_SECRET ?? "development-auth-secret-that-is-longer-than-32");
  const actor = (request: FastifyRequest, reply: FastifyReply): string | null => requireActor(request, reply, auth);
  const capabilityTokens = new CapabilityTokenService(process.env.CAPABILITY_SECRET ?? "development-secret-that-is-longer-than-32-characters");
  const artifacts = new ArtifactService(service.store, capabilityTokens);
  const workload = new WorkloadService(service.store, capabilityTokens, [], undefined, artifacts);
  const cleanupRuntime = new InMemorySandboxRuntime([]);
  const cleanup = new OrderCleanupService(service, workload, artifacts, cleanupRuntime);
  const metering = new MeteringService(service.store);
  const settlement = new SettlementService(service.store, metering);
  const paymentWebhooks = new PaymentWebhookProcessor(service, process.env.PAYMENT_WEBHOOK_SECRET ?? "development-payment-webhook-secret-longer-than-32");

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
    void reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "服务内部错误" } });
  });

  app.get("/health", async () => ({ status: "ok", service: "sourx-exchange" }));

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
    const actorId = actor(request, reply);
    if (!actorId) return;
    const lease = service.getLeaseForProvider(actorId, routeId(request));
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
    const expiresAt = Math.floor(Date.now() / 1000) + order.durationMinutes * 60;
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
    const result = cleanup.endOrder(order.id);
    return reply.send({ ...result.order, cleanup: result.report });
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

