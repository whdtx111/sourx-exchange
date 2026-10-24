export type UserRole = "buyer" | "provider" | "operator";
export type UserStatus = "active" | "suspended";
export type NodeStatus = "pending_enrollment" | "online" | "draining" | "offline" | "quarantined";
export type ListingStatus = "draft" | "pending_review" | "published" | "paused" | "retired";
export type OrderStatus =
  | "created"
  | "payment_pending"
  | "paid"
  | "allocating"
  | "active"
  | "ending"
  | "completed"
  | "cancelled"
  | "failed"
  | "disputed"
  | "refunded";
export type LeaseStatus =
  | "requested"
  | "reserving"
  | "starting"
  | "ready"
  | "running"
  | "stopping"
  | "ended"
  | "start_failed"
  | "interrupted"
  | "cleanup_failed";
export type PaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "settled"
  | "failed"
  | "voided"
  | "partially_refunded"
  | "disputed";

export interface User {
  id: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface GpuResource {
  id: string;
  uuid: string;
  model: string;
  vramMb: number;
  cudaVersion: string;
  benchmarkScore: number;
  available: boolean;
}

export interface ComputeNode {
  id: string;
  providerId: string;
  status: NodeStatus;
  agentVersion: string;
  region: string;
  lastHeartbeatAt: string | null;
  gpus: GpuResource[];
  enrollmentFingerprint: string;
}

export interface Listing {
  id: string;
  providerId: string;
  nodeId: string;
  gpuId: string;
  status: ListingStatus;
  pricePerHourMinor: number;
  minimumMinutes: number;
  imageDigests: string[];
  version: number;
}

export interface Order {
  id: string;
  buyerId: string;
  listingId: string;
  durationMinutes: number;
  pricePerHourMinor: number;
  computeAmountMinor: number;
  platformFeeMinor: number;
  totalAmountMinor: number;
  status: OrderStatus;
  createdAt: string;
  paidAt: string | null;
  endedAt: string | null;
}

export interface Payment {
  id: string;
  orderId: string;
  providerReference: string | null;
  status: PaymentStatus;
  amountMinor: number;
  createdAt: string;
}

export interface Lease {
  id: string;
  orderId: string;
  nodeId: string;
  gpuId: string;
  status: LeaseStatus;
  tokenVersion: number;
  sandboxId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

