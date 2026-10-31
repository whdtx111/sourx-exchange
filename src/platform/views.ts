import { DomainError, forbidden, notFound } from "../domain/errors.js";
import type { MarketplaceService } from "../domain/service.js";
import type { Listing, Order, User } from "../domain/types.js";
import type { MeteringService } from "../billing/metering.js";
import type { SettlementService } from "../billing/settlement.js";

export class PortalViews {
  constructor(private readonly service: MarketplaceService, private readonly meter: MeteringService, private readonly settlement: SettlementService) {}

  listing(listing: Listing) {
    const node = this.service.store.nodes.get(listing.nodeId)!;
    const gpu = node.gpus.find((g) => g.id === listing.gpuId)!;
    const reserved = [...this.service.store.reservations.values()].some((r) => r.gpuId === gpu.id);
    return {
      id: listing.id, status: listing.status, pricePerHourMinor: listing.pricePerHourMinor,
      minimumMinutes: listing.minimumMinutes, imageDigests: listing.imageDigests, version: listing.version,
      region: node.region, providerLabel: `算力供应商 ${listing.providerId.slice(-4).toUpperCase()}`,
      gpu: { model: gpu.model, vramMb: gpu.vramMb, cudaVersion: gpu.cudaVersion, benchmarkScore: gpu.benchmarkScore },
      available: listing.status === "published" && node.status === "online" && gpu.available && !reserved,
    };
  }

  catalog() {
    this.service.expireReservations();
    return this.service.getVisibleListings().filter((l) => this.service.store.nodes.get(l.nodeId)?.status === "online").map((l) => this.listing(l));
  }

  order(order: Order) {
    const listing = this.service.store.listings.get(order.listingId)!;
    const payment = [...this.service.store.payments.values()].find((p) => p.orderId === order.id);
    const lease = this.service.findLeaseForOrder(order.id);
    return {
      id: order.id, listingId: order.listingId, durationMinutes: order.durationMinutes,
      pricePerHourMinor: order.pricePerHourMinor, computeAmountMinor: order.computeAmountMinor,
      platformFeeMinor: order.platformFeeMinor, totalAmountMinor: order.totalAmountMinor,
      status: order.status, createdAt: order.createdAt, paidAt: order.paidAt, endedAt: order.endedAt,
      listing: this.listing(listing), payment: payment ? { id: payment.id, status: payment.status, amountMinor: payment.amountMinor } : null,
      lease: lease ? { id: lease.id, status: lease.status, startedAt: lease.startedAt, endedAt: lease.endedAt } : null,
      billableSeconds: this.meter.billableSeconds(order.id), settlement: this.settlement.getForOrder(order.id),
    };
  }

  orders(user: User) {
    return [...this.service.store.orders.values()]
      .filter((o) => user.role === "operator" || (user.role === "buyer" ? o.buyerId === user.id : this.service.store.listings.get(o.listingId)?.providerId === user.id))
      .sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map((o) => this.order(o));
  }

  buyerOrder(userId: string, orderId: string) { return this.order(this.service.getOrderForBuyer(userId, orderId)); }

  providerOrder(userId: string, orderId: string) {
    this.service.requireUser(userId, "provider");
    const order = this.service.store.orders.get(orderId);
    if (!order) throw notFound("订单");
    if (this.service.store.listings.get(order.listingId)?.providerId !== userId) throw forbidden("不能查看其他卖家的订单");
    return this.order(order);
  }

  providerNodes(userId: string) {
    this.service.requireUser(userId, "provider");
    return [...this.service.store.nodes.values()].filter((n) => n.providerId === userId).map(({enrollmentFingerprint, ...node}) => node);
  }

  providerListings(userId: string) {
    this.service.requireUser(userId, "provider");
    return [...this.service.store.listings.values()].filter((l) => l.providerId === userId).map((l) => ({...this.listing(l), nodeId: l.nodeId, gpuId: l.gpuId}));
  }

  earnings(user: User) {
    if (user.role !== "provider") throw new DomainError("FORBIDDEN", "仅卖家可查看收益");
    const orders = this.orders(user);
    const settled = orders.filter((o) => o.settlement?.status === "settled");
    return { settledMinor: settled.reduce((sum, o) => sum + o.settlement!.providerPayoutMinor, 0),
      pendingOrders: orders.filter((o) => ["active", "paid", "allocating", "completed"].includes(o.status) && !o.settlement).length,
      completedOrders: settled.length,
      entries: settled.map((o) => ({model: o.listing.gpu.model, ...o.settlement!})) };
  }
}
