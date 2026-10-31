import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MarketplaceService } from "../domain/service.js";
import type { AuthService } from "../auth/service.js";
import type { WorkloadService } from "../workload/job.js";
import type { SettlementService } from "../billing/settlement.js";
import type { UserRole } from "../domain/types.js";
import { DomainError } from "../domain/errors.js";
import { PortalViews } from "./views.js";

type IdRequest = FastifyRequest<{Params:{id:string}}>;
export function registerPortalRoutes(app: FastifyInstance, context: {
  service: MarketplaceService; auth: AuthService; views: PortalViews; workload: WorkloadService;
  settlement: SettlementService; localMode: boolean;
  actor: (request: FastifyRequest, reply: FastifyReply) => string | null;
  startLocalLease: (orderId: string) => void;
}) {
  const {service, auth, views, workload, settlement, actor, localMode, startLocalLease} = context;
  const roles: Record<string, UserRole> = {buyer:"buyer",provider:"provider",operator:"operator"};
  app.addHook("preHandler", async (request, reply) => {
    const segment = request.url.split("/")[2] ?? "";
    const role = roles[segment];
    if (!role) return;
    const id = actor(request,reply);
    if (id) service.requireUser(id,role);
  });
  const current = (request: FastifyRequest, reply: FastifyReply) => {
    const id = actor(request,reply);
    return id ? service.requireUser(id) : null;
  };
  app.get("/v1/config", async () => ({localMode, paymentMode:localMode ? "sandbox" : "unconfigured", runtimeMode:localMode ? "simulated" : "external",
    sampleAccounts: localMode ? [{identifier:"buyer@sourx.local",role:"buyer"},{identifier:"seller@sourx.local",role:"provider"},{identifier:"operator@sourx.local",role:"operator"}] : []}));
  app.get("/v1/me", async (request,reply) => {
    const user = current(request,reply); if (!user) return;
    return {...user,identifier:auth.identifierFor(user.id)};
  });
  app.get("/v1/catalog", async () => ({items:views.catalog()}));
  app.get("/v1/catalog/:id", async (request: IdRequest,reply) => {
    const item = views.catalog().find((l) => l.id === request.params.id);
    return item ?? reply.code(404).send({error:{code:"NOT_FOUND",message:"商品未上架或节点不可用"}});
  });
  app.get("/v1/buyer/orders", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:views.orders(user)};
  });
  app.get("/v1/buyer/orders/:id", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (user) return views.buyerOrder(user.id,request.params.id);
  });
  app.get("/v1/buyer/jobs", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:workload.listForOwner(user.id)};
  });
  app.post("/v1/buyer/orders/:id/cancel", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (user) return service.cancelOrder(user.id,request.params.id);
  });
  app.post("/v1/buyer/orders/:id/pay", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (!user) return;
    if (!localMode) throw new DomainError("PAYMENT_UNAVAILABLE","支付渠道尚未配置");
    service.expireReservations();
    const order = service.getOrderForBuyer(user.id,request.params.id);
    if (!["payment_pending","paid","allocating","active"].includes(order.status)) throw new DomainError("INVALID_ORDER_STATE","订单当前不能支付");
    if (order.status === "active") return views.buyerOrder(user.id,order.id);
    const payment = [...service.store.payments.values()].find((p) => p.orderId === order.id)!;
    service.authorizePayment(payment.id,`sandbox_${order.id}`);
    startLocalLease(order.id);
    return views.buyerOrder(user.id,order.id);
  });
  app.get("/v1/provider/nodes", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:views.providerNodes(user.id)};
  });
  app.patch("/v1/provider/nodes/:id", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (!user) return;
    const input = z.object({status:z.enum(["online","draining"])}).strict().parse(request.body);
    service.setNodeStatus(user.id,request.params.id,input.status);
    return {ok:true};
  });
  app.get("/v1/provider/listings", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:views.providerListings(user.id)};
  });
  app.patch("/v1/provider/listings/:id", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (!user) return;
    const input = z.object({pricePerHourMinor:z.number().int().min(1).max(10000000),minimumMinutes:z.number().int().min(1).max(10080)}).strict().parse(request.body);
    return service.updateListing(user.id,request.params.id,input);
  });
  app.post("/v1/provider/listings/:id/status", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (!user) return;
    const input = z.object({status:z.enum(["published","paused"])}).strict().parse(request.body);
    return service.setListingStatus(user.id,request.params.id,input.status);
  });
  app.get("/v1/provider/orders", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:views.orders(user)};
  });
  app.get("/v1/provider/orders/:id", async (request: IdRequest,reply) => {
    const user = current(request,reply); if (user) return views.providerOrder(user.id,request.params.id);
  });
  app.get("/v1/provider/earnings", async (request,reply) => {
    const user = current(request,reply); if (user) return views.earnings(user);
  });
  app.get("/v1/operator/listings", async () => ({items:[...service.store.listings.values()].map((l) => views.listing(l))}));
  app.get("/v1/operator/orders", async (request,reply) => {
    const user = current(request,reply); if (user) return {items:views.orders(user)};
  });
  app.get("/v1/operator/audit", async () => ({items:[...service.store.auditEvents].reverse().slice(0,200)}));
  app.post("/v1/operator/orders/:id/settle", async (request: IdRequest) => settlement.settle(request.params.id));
}
