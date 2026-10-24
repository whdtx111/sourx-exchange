import { createHash } from "node:crypto";
import { DomainError, forbidden, notFound } from "./errors.js";
import { id, type DomainStore } from "./store.js";
import type {
  ComputeNode,
  GpuResource,
  Lease,
  Listing,
  Order,
  Payment,
  User,
  UserRole,
} from "./types.js";

const now = (): string => new Date().toISOString();

const assertRole = (user: User, role: UserRole): void => {
  if (user.status !== "active" || user.role !== role) {
    throw forbidden(`用户没有 ${role} 权限`);
  }
};

const percentageFee = (amountMinor: number, basisPoints: number): number =>
  Math.floor((amountMinor * basisPoints) / 10_000);

export class MarketplaceService {
  public constructor(private readonly store: DomainStore) {}

  public createUser(role: UserRole): User {
    const user: User = { id: id("usr"), role, status: "active", createdAt: now() };
    this.store.users.set(user.id, user);
    return user;
  }

  public suspendUser(actorId: string, userId: string): void {
    this.requireUser(actorId, "operator");
    const user = this.store.users.get(userId);
    if (!user) throw notFound("用户");
    user.status = "suspended";
    this.audit(actorId, "user.suspend", "user", userId, {});
  }

  public registerNode(
    providerId: string,
    input: {
      region: string;
      agentVersion: string;
      gpus: Omit<GpuResource, "id" | "available">[];
      certificateFingerprint: string;
    },
  ): ComputeNode {
    this.requireUser(providerId, "provider");
    if (input.gpus.length === 0) {
      throw new DomainError("INVALID_NODE", "节点至少需要一张 GPU");
    }
    const node: ComputeNode = {
      id: id("node"),
      providerId,
      status: "online",
      agentVersion: input.agentVersion,
      region: input.region,
      lastHeartbeatAt: now(),
      enrollmentFingerprint: input.certificateFingerprint,
      gpus: input.gpus.map((gpu) => ({ ...gpu, id: id("gpu"), available: true })),
    };
    this.store.nodes.set(node.id, node);
    this.audit(providerId, "node.register", "node", node.id, { gpuCount: node.gpus.length });
    return node;
  }

  public heartbeat(providerId: string, nodeId: string, at = now()): ComputeNode {
    this.requireUser(providerId, "provider");
    const node = this.store.nodes.get(nodeId);
    if (!node) throw notFound("节点");
    if (node.providerId !== providerId) throw forbidden("不能操作其他卖家的节点");
    if (node.status === "quarantined") {
      throw new DomainError("NODE_QUARANTINED", "节点已隔离，不能恢复心跳");
    }
    node.status = "online";
    node.lastHeartbeatAt = at;
    return node;
  }

  public createListing(
    providerId: string,
    input: { nodeId: string; gpuId: string; pricePerHourMinor: number; minimumMinutes: number; imageDigests: string[] },
  ): Listing {
    this.requireUser(providerId, "provider");
    const node = this.store.nodes.get(input.nodeId);
    if (!node) throw notFound("节点");
    if (node.providerId !== providerId) throw forbidden("不能使用其他卖家的节点");
    const gpu = node.gpus.find((candidate) => candidate.id === input.gpuId);
    if (!gpu) throw notFound("GPU");
    if (input.pricePerHourMinor <= 0 || input.minimumMinutes <= 0) {
      throw new DomainError("INVALID_PRICING", "价格和最短租用时长必须为正数");
    }
    if (input.imageDigests.length === 0 || input.imageDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      throw new DomainError("INVALID_IMAGE", "必须提供至少一个合法的 sha256 镜像 digest");
    }
    const listing: Listing = {
      id: id("lst"),
      providerId,
      nodeId: node.id,
      gpuId: gpu.id,
      status: "pending_review",
      pricePerHourMinor: input.pricePerHourMinor,
      minimumMinutes: input.minimumMinutes,
      imageDigests: [...input.imageDigests],
      version: 1,
    };
    this.store.listings.set(listing.id, listing);
    this.audit(providerId, "listing.create", "listing", listing.id, { version: listing.version });
    return listing;
  }

  public publishListing(operatorId: string, listingId: string): Listing {
    this.requireUser(operatorId, "operator");
    const listing = this.store.listings.get(listingId);
    if (!listing) throw notFound("算力商品");
    if (listing.status !== "pending_review" && listing.status !== "paused") {
      throw new DomainError("INVALID_LISTING_STATE", "只有待审核或暂停中的商品可以上架");
    }
    listing.status = "published";
    this.audit(operatorId, "listing.publish", "listing", listingId, {});
    return listing;
  }

  public createOrder(buyerId: string, listingId: string, durationMinutes: number): { order: Order; payment: Payment } {
    this.requireUser(buyerId, "buyer");
    const listing = this.store.listings.get(listingId);
    if (!listing) throw notFound("算力商品");
    if (listing.status !== "published") throw new DomainError("LISTING_UNAVAILABLE", "算力商品当前不可购买");
    if (durationMinutes < listing.minimumMinutes) {
      throw new DomainError("DURATION_TOO_SHORT", "租用时长低于商品最低时长");
    }
    const node = this.store.nodes.get(listing.nodeId);
    const gpu = node?.gpus.find((candidate) => candidate.id === listing.gpuId);
    if (!node || !gpu || node.status !== "online" || !gpu.available) {
      throw new DomainError("RESOURCE_UNAVAILABLE", "GPU 当前不可用");
    }
    const computeAmountMinor = Math.ceil((listing.pricePerHourMinor * durationMinutes) / 60);
    const platformFeeMinor = percentageFee(computeAmountMinor, 500);
    const order: Order = {
      id: id("ord"),
      buyerId,
      listingId,
      durationMinutes,
      pricePerHourMinor: listing.pricePerHourMinor,
      computeAmountMinor,
      platformFeeMinor,
      totalAmountMinor: computeAmountMinor + platformFeeMinor,
      status: "payment_pending",
      createdAt: now(),
      paidAt: null,
      endedAt: null,
    };
    const payment: Payment = {
      id: id("pay"),
      orderId: order.id,
      providerReference: null,
      status: "created",
      amountMinor: order.totalAmountMinor,
      createdAt: now(),
    };
    this.store.orders.set(order.id, order);
    this.store.payments.set(payment.id, payment);
    this.audit(buyerId, "order.create", "order", order.id, { listingId, totalAmountMinor: order.totalAmountMinor });
    return { order, payment };
  }

  public authorizePayment(paymentId: string, providerReference: string): Payment {
    const payment = this.store.payments.get(paymentId);
    if (!payment) throw notFound("支付意图");
    if (payment.status === "authorized") return payment;
    if (payment.status !== "created") throw new DomainError("INVALID_PAYMENT_STATE", "支付意图不能授权");
    const order = this.store.orders.get(payment.orderId);
    if (!order) throw notFound("订单");
    payment.status = "authorized";
    payment.providerReference = providerReference;
    order.status = "paid";
    order.paidAt = now();
    this.audit("payment-provider", "payment.authorize", "payment", payment.id, { orderId: order.id });
    return payment;
  }

  public allocateLease(orderId: string): Lease {
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (order.status !== "paid") throw new DomainError("ORDER_NOT_PAID", "订单尚未完成支付授权");
    const listing = this.store.listings.get(order.listingId);
    if (!listing) throw notFound("算力商品");
    const node = this.store.nodes.get(listing.nodeId);
    const gpu = node?.gpus.find((candidate) => candidate.id === listing.gpuId);
    if (!node || !gpu || node.status !== "online" || !gpu.available) {
      throw new DomainError("RESOURCE_UNAVAILABLE", "GPU 当前不可用");
    }
    if ([...this.store.leases.values()].some((lease) =>
      lease.gpuId === gpu.id && ["requested", "reserving", "starting", "ready", "running", "stopping"].includes(lease.status),
    )) {
      throw new DomainError("RESOURCE_RACE", "GPU 已被其他租约占用");
    }
    gpu.available = false;
    order.status = "allocating";
    const lease: Lease = {
      id: id("lease"),
      orderId,
      nodeId: node.id,
      gpuId: gpu.id,
      status: "requested",
      tokenVersion: 1,
      sandboxId: null,
      startedAt: null,
      endedAt: null,
    };
    this.store.leases.set(lease.id, lease);
    this.audit("scheduler", "lease.allocate", "lease", lease.id, { orderId, gpuId: gpu.id });
    return lease;
  }

  public markLeaseReady(leaseId: string, sandboxId: string): Lease {
    const lease = this.store.leases.get(leaseId);
    if (!lease) throw notFound("租约");
    const order = this.store.orders.get(lease.orderId);
    if (!order) throw notFound("订单");
    if (lease.status !== "requested" && lease.status !== "starting") {
      throw new DomainError("INVALID_LEASE_STATE", "租约当前不能进入 ready");
    }
    lease.status = "ready";
    lease.sandboxId = sandboxId;
    order.status = "active";
    lease.startedAt = now();
    return lease;
  }

  public endOrder(orderId: string): Order {
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (!["paid", "allocating", "active", "ending"].includes(order.status)) {
      throw new DomainError("INVALID_ORDER_STATE", "订单当前不能结束");
    }
    order.status = "completed";
    order.endedAt = now();
    const lease = [...this.store.leases.values()].find((candidate) => candidate.orderId === orderId);
    if (lease) {
      lease.status = "ended";
      lease.endedAt = order.endedAt;
      const node = this.store.nodes.get(lease.nodeId);
      const gpu = node?.gpus.find((candidate) => candidate.id === lease.gpuId);
      if (gpu) gpu.available = true;
      lease.tokenVersion += 1;
    }
    this.audit("system", "order.complete", "order", orderId, {});
    return order;
  }

  public getVisibleListings(): Listing[] {
    return [...this.store.listings.values()].filter((listing) => listing.status === "published");
  }

  public getOrderForBuyer(buyerId: string, orderId: string): Order {
    this.requireUser(buyerId, "buyer");
    const order = this.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (order.buyerId !== buyerId) throw forbidden("不能查看其他买家的订单");
    return order;
  }

  public getNodeForProvider(providerId: string, nodeId: string): ComputeNode {
    this.requireUser(providerId, "provider");
    const node = this.store.nodes.get(nodeId);
    if (!node) throw notFound("节点");
    if (node.providerId !== providerId) throw forbidden("不能查看其他卖家的节点");
    return node;
  }

  public auditEvents(): readonly unknown[] {
    return this.store.auditEvents;
  }

  public requireUser(userId: string, role?: UserRole): User {
    const user = this.store.users.get(userId);
    if (!user) throw notFound("用户");
    if (role) assertRole(user, role);
    if (user.status !== "active") throw forbidden("用户已被停用");
    return user;
  }

  private audit(actorId: string, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>): void {
    this.store.auditEvents.push({
      id: id("audit"),
      actorId,
      action,
      resourceType,
      resourceId,
      occurredAt: now(),
      metadata,
    });
  }
}

export const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

