import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkloadService } from "../workload/job.js";

const submitSchema = z.object({
  orderId: z.string().min(1),
  leaseId: z.string().min(1),
  imageDigest: z.string().min(1),
  command: z.array(z.string()).min(1),
  inputArtifactIds: z.array(z.string()).max(100).default([]),
  maxRuntimeSeconds: z.number().int().positive(),
});

const bearer = (request: FastifyRequest, reply: FastifyReply): string | null => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    void reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "缺少 capability token" } });
    return null;
  }
  return authorization.slice("Bearer ".length);
};

type IdRequest = FastifyRequest<{ Params: { id: string } }>;

export const registerGatewayRoutes = (app: FastifyInstance, workload: WorkloadService): void => {
  app.post("/v1/gateway/jobs", async (request, reply) => {
    const token = bearer(request, reply);
    if (!token) return;
    const job = workload.submit(token, submitSchema.parse(request.body));
    return reply.code(201).send(job);
  });

  app.get("/v1/gateway/jobs/:id", async (request: IdRequest, reply) => {
    const token = bearer(request, reply);
    if (!token) return;
    return reply.send(workload.get(token, request.params.id));
  });

  app.post("/v1/gateway/jobs/:id/cancel", async (request: IdRequest, reply) => {
    const token = bearer(request, reply);
    if (!token) return;
    return reply.send(workload.cancel(token, request.params.id));
  });
};

