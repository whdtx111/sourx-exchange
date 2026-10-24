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

type ActorRequest = FastifyRequest<{ Body: unknown; Params: { id: string } }>;
type IdRequest = FastifyRequest<{ Params: { id: string } }>;

const actorId = (request: FastifyRequest): string | null => {
  const value = request.headers["x-user-id"];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const routeId = (request: IdRequest): string => request.params.id;

const requireActor = (request: FastifyRequest, reply: FastifyReply): string | null => {
  const id = actorId(request);
  if (!id) {
    void reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "缺少 x-user-id" } });
    return null;
  }
  return id;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => schema.parse(value);

export const createApp = (service: MarketplaceService): FastifyInstance => {
  const app = Fastify({ logger: false });
  const capabilityTokens = new CapabilityTokenService(process.env.CAPABILITY_SECRET ?? "development-secret-that-is-longer-than-32-characters");
  const artifacts = new ArtifactService(service.store, capabilityTokens);
  const workload = new WorkloadService(service.store, capabilityTokens, [], undefined, artifacts);
  const cleanupRuntime = new InMemorySandboxRuntime([]);
  const cleanup = new OrderCleanupService(service, workload, artifacts, cleanupRuntime);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : 400;
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
    const input = parse(userRoleSchema, request.body);
    const user = service.createUser(input.role);
    return reply.code(201).send(user);
  });

  app.post("/v1/nodes", async (request, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    const node = service.registerNode(actor, parse(nodeSchema, request.body));
    return reply.code(201).send(node);
  });

  app.post("/v1/nodes/:id/heartbeat", async (request: IdRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    return reply.send(service.heartbeat(actor, routeId(request)));
  });

  app.post("/v1/listings", async (request, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    const listing = service.createListing(actor, parse(listingSchema, request.body));
    return reply.code(201).send(listing);
  });

  app.post("/v1/listings/:id/publish", async (request: IdRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    return reply.send(service.publishListing(actor, routeId(request)));
  });

  app.get("/v1/listings", async () => service.getVisibleListings());

  app.post("/v1/orders", async (request, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    const result = service.createOrder(actor, parse(orderSchema, request.body).listingId, parse(orderSchema, request.body).durationMinutes);
    return reply.code(201).send(result);
  });

  app.post("/v1/payments/:id/authorize", async (request: ActorRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    service.requireUser(actor, "operator");
    return reply.send(service.authorizePayment(routeId(request), parse(paymentSchema, request.body).providerReference));
  });

  app.post("/v1/orders/:id/lease", async (request: IdRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    service.requireUser(actor, "operator");
    return reply.code(201).send(service.allocateLease(routeId(request)));
  });

  app.post("/v1/leases/:id/ready", async (request: ActorRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    service.requireUser(actor, "operator");
    return reply.send(service.markLeaseReady(routeId(request), parse(readySchema, request.body).sandboxId));
  });

  app.get("/v1/orders/:id/capability", async (request: IdRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    const order = service.getOrderForBuyer(actor, routeId(request));
    const lease = service.getLeaseForOrder(order.id);
    if (!["ready", "running"].includes(lease.status)) {
      throw new DomainError("LEASE_NOT_READY", "租约当前不能签发 capability token");
    }
    const expiresAt = Math.floor(Date.now() / 1000) + order.durationMinutes * 60;
    const token = capabilityTokens.issue({
      subject: actor,
      orderId: order.id,
      leaseId: lease.id,
      scopes: ["job:create", "job:read", "job:cancel", "artifact:read", "artifact:write"],
      version: lease.tokenVersion,
      expiresAt,
    });
    return reply.send({ token, expiresAt, orderId: order.id, leaseId: lease.id });
  });

  app.get("/v1/orders/:id", async (request: ActorRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    return reply.send(service.getOrderForBuyer(actor, routeId(request)));
  });

  app.post("/v1/orders/:id/end", async (request: IdRequest, reply) => {
    const actor = requireActor(request, reply);
    if (!actor) return;
    const order = service.getOrderForBuyer(actor, routeId(request));
    const result = cleanup.endOrder(order.id);
    return reply.send({ ...result.order, cleanup: result.report });
  });

  registerGatewayRoutes(app, workload, artifacts);

  return app;
};

