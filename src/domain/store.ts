import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  ComputeNode,
  Lease,
  Listing,
  Order,
  Payment,
  User,
} from "./types.js";

export interface DomainStore {
  users: Map<string, User>;
  nodes: Map<string, ComputeNode>;
  listings: Map<string, Listing>;
  orders: Map<string, Order>;
  payments: Map<string, Payment>;
  leases: Map<string, Lease>;
  reservations: Map<string, ResourceReservation>;
  auditEvents: AuditEvent[];
}

export interface ResourceReservation {
  id: string;
  orderId: string;
  gpuId: string;
  expiresAt: string;
}

export const createStore = (): DomainStore => ({
  users: new Map(),
  nodes: new Map(),
  listings: new Map(),
  orders: new Map(),
  payments: new Map(),
  leases: new Map(),
  reservations: new Map(),
  auditEvents: [],
});

export const id = (prefix: string): string => `${prefix}_${randomUUID()}`;

