import { createHash, randomBytes } from "node:crypto";
import { DomainError, notFound } from "../domain/errors.js";
import { MarketplaceService } from "../domain/service.js";
import type { ComputeNode, GpuResource } from "../domain/types.js";
import { EnrollmentCodeStore } from "./enrollment.js";

interface AgentCredential {
  nodeId: string;
  providerId: string;
  tokenHash: string;
  expiresAt: number;
  revoked: boolean;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface AgentNodeInput {
  region: string;
  agentVersion: string;
  gpus: Omit<GpuResource, "id" | "available">[];
  certificateFingerprint: string;
}

export class AgentRegistry {
  private readonly credentials = new Map<string, AgentCredential>();

  public constructor(
    private readonly marketplace: MarketplaceService,
    private readonly enrollments: EnrollmentCodeStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public issueEnrollmentCode(providerId: string, ttlMs?: number): string {
    this.marketplace.requireUser(providerId, "provider");
    return this.enrollments.issue(providerId, ttlMs);
  }

  public enroll(code: string, input: AgentNodeInput): { node: ComputeNode; agentToken: string; expiresAt: number } {
    const { providerId } = this.enrollments.consume(code);
    const node = this.marketplace.registerNode(providerId, input);
    const agentToken = randomBytes(32).toString("base64url");
    const expiresAt = this.clock() + 30 * 24 * 60 * 60 * 1000;
    this.credentials.set(node.id, { nodeId: node.id, providerId, tokenHash: hash(agentToken), expiresAt, revoked: false });
    return { node, agentToken, expiresAt };
  }

  public verify(agentToken: string, nodeId: string): { nodeId: string; providerId: string } {
    const credential = this.credentials.get(nodeId);
    if (!credential || credential.revoked || credential.expiresAt <= this.clock() || credential.tokenHash !== hash(agentToken)) {
      throw new DomainError("INVALID_AGENT_CREDENTIAL", "Agent 凭证无效、已过期或已吊销");
    }
    return { nodeId: credential.nodeId, providerId: credential.providerId };
  }

  public heartbeat(agentToken: string, nodeId: string, at?: string): ComputeNode {
    const identity = this.verify(agentToken, nodeId);
    if (at) {
      const timestamp = Date.parse(at);
      if (!Number.isFinite(timestamp) || timestamp > this.clock() + 60_000 || timestamp < this.clock() - 10 * 60_000) throw new DomainError("INVALID_HEARTBEAT_TIME", "Agent 心跳时间不合法");
      return this.marketplace.heartbeat(identity.providerId, identity.nodeId, at);
    }
    return this.marketplace.heartbeat(identity.providerId, identity.nodeId);
  }

  public revoke(nodeId: string): void {
    const credential = this.credentials.get(nodeId);
    if (!credential) throw notFound("Agent 凭证");
    credential.revoked = true;
  }

  public assertNode(agentToken: string, nodeId: string): void {
    this.verify(agentToken, nodeId);
  }
}
