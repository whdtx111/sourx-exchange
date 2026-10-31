import type { MarketplaceService } from "./domain/service.js";
import type { MeteringService } from "./billing/metering.js";
import type { AuthService } from "./auth/service.js";
import type { SettlementService } from "./billing/settlement.js";

export const demoImageDigest = "sha256:" + "d".repeat(64);
export const localPassword = "SourX.local2026!";

/** Local sample accounts are separate real accounts; never expose their access tokens through a public API. */
export function initializeDemo(service: MarketplaceService, metering: MeteringService, auth: AuthService, settlement: SettlementService) {
  if (service.store.users.size > 0) return;
  const buyer = auth.register("buyer@sourx.local", localPassword, "buyer");
  const provider = auth.register("seller@sourx.local", localPassword, "provider");
  const otherProvider = auth.register("studio@sourx.local", localPassword, "provider");
  const operator = service.createUser("operator");
  auth.attachAccount("operator@sourx.local", localPassword, operator.id);
  const specs = [
    {model:"RTX 5090", vram:32, cuda:"12.8", score:2180, price:278, region:"cn-east-1"},
    {model:"RTX 4090", vram:24, cuda:"12.4", score:1660, price:168, region:"cn-east-1"},
    {model:"A100 PCIe", vram:80, cuda:"12.4", score:3450, price:890, region:"cn-north-1"},
    {model:"RTX 3090", vram:24, cuda:"12.2", score:1020, price:98, region:"cn-south-1"},
    {model:"L40S", vram:48, cuda:"12.4", score:2360, price:480, region:"cn-north-1"},
    {model:"RTX 5080", vram:16, cuda:"12.8", score:1740, price:218, region:"cn-east-1"},
  ];
  for (const [i,s] of specs.entries()) {
    const owner = i < 3 ? provider : otherProvider;
    const node = service.registerNode(owner.id, {region:s.region, agentVersion:"1.0.0-local", certificateFingerprint:`sourx-local-device-${i}-fingerprint`,
      gpus:[{uuid:`GPU-SOURX-LOCAL-${i}`,model:s.model,vramMb:s.vram*1024,cudaVersion:s.cuda,benchmarkScore:s.score}]});
    const listing = service.createListing(owner.id, {nodeId:node.id,gpuId:node.gpus[0]!.id,pricePerHourMinor:s.price,minimumMinutes:30,imageDigests:[demoImageDigest]});
    service.publishListing(operator.id,listing.id);
    if (i === 1 || i === 2 || i === 3) {
      const {order,payment} = service.createOrder(buyer.id,listing.id,120);
      service.authorizePayment(payment.id,"local-sandbox-seed");
      const lease = service.allocateLease(order.id);
      service.markLeaseReady(lease.id,`sandbox_${lease.id}`);
      metering.record({leaseId:lease.id,observedAtEpoch:Math.floor(Date.now()/1000),heartbeat:true,sandboxState:"running",gpuUuid:node.gpus[0]!.uuid});
      if (i === 2 || i === 3) { service.endOrder(order.id); settlement.settle(order.id); }
    }
  }
}
