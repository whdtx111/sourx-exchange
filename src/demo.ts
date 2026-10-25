import type { MarketplaceService } from "./domain/service.js";
import type { MeteringService } from "./billing/metering.js";
import type { ComputeNode, Lease, Listing, Order, Payment, User } from "./domain/types.js";

const demoImage = "sha256:" + "d".repeat(64);

export interface DemoState {
  users: { buyer: User; provider: User; operator: User };
  node: ComputeNode;
  listing: Listing;
  order: Order;
  payment: Payment;
  lease: Lease;
}

/** Creates one repeatable in-memory scenario for local product demos. */
export const initializeDemo = (service: MarketplaceService, metering: MeteringService): DemoState => {
  const buyer = service.createUser("buyer");
  const provider = service.createUser("provider");
  const operator = service.createUser("operator");
  const node = service.registerNode(provider.id, {
    region: "cn-east-1",
    agentVersion: "0.1.0-demo",
    certificateFingerprint: "sourx-demo-certificate-fingerprint",
    gpus: [{ uuid: "GPU-SOURX-5090-DEMO", model: "RTX 5090", vramMb: 32_768, cudaVersion: "12.8", benchmarkScore: 2_180 }],
  });
  const listing = service.createListing(provider.id, {
    nodeId: node.id,
    gpuId: node.gpus[0]!.id,
    pricePerHourMinor: 278,
    minimumMinutes: 30,
    imageDigests: [demoImage],
  });
  service.publishListing(operator.id, listing.id);
  const created = service.createOrder(buyer.id, listing.id, 60);
  const payment = service.authorizePayment(created.payment.id, "demo-escrow-authorized");
  const lease = service.allocateLease(created.order.id);
  service.markLeaseReady(lease.id, "sandbox_demo_5090");
  metering.record({
    leaseId: lease.id,
    observedAtEpoch: Math.floor(Date.now() / 1000) - 30,
    heartbeat: true,
    sandboxState: "running",
    gpuUuid: node.gpus[0]!.uuid,
  });
  return { users: { buyer, provider, operator }, node, listing, order: created.order, payment, lease };
};

export const demoImageDigest = demoImage;
