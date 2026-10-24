import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors.js";

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

const mac = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(value).digest("base64url");

const equalMac = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export type CapabilityScope = "job:create" | "job:read" | "job:cancel" | "artifact:read" | "artifact:write";

export interface CapabilityClaims {
  typ: "sourx-capability";
  aud: "sourx-gateway";
  jti: string;
  subject: string;
  orderId: string;
  leaseId: string;
  scopes: CapabilityScope[];
  version: number;
  issuedAt: number;
  expiresAt: number;
}

export class CapabilityTokenService {
  public constructor(private readonly secret: string, private readonly clock: () => number = () => Date.now()) {
    if (secret.length < 32) throw new Error("capability token secret 至少需要 32 个字符");
  }

  public issue(input: Omit<CapabilityClaims, "typ" | "aud" | "jti" | "issuedAt">): string {
    const issuedAt = Math.floor(this.clock() / 1000);
    if (input.expiresAt <= issuedAt) throw new DomainError("INVALID_TOKEN_TTL", "token 过期时间必须晚于当前时间");
    const claims: CapabilityClaims = {
      typ: "sourx-capability",
      aud: "sourx-gateway",
      jti: randomUUID(),
      issuedAt,
      ...input,
    };
    const encoded = encode(JSON.stringify(claims));
    return `${encoded}.${mac(this.secret, encoded)}`;
  }

  public verify(
    token: string,
    options: { requiredScope?: CapabilityScope; orderId?: string; leaseId?: string; expectedVersion?: number } = {},
  ): CapabilityClaims {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new DomainError("INVALID_TOKEN", "token 格式不合法");
    if (!equalMac(mac(this.secret, encoded), signature)) throw new DomainError("INVALID_TOKEN", "token 签名无效");
    let claims: CapabilityClaims;
    try {
      claims = JSON.parse(decode(encoded)) as CapabilityClaims;
    } catch {
      throw new DomainError("INVALID_TOKEN", "token 内容无效");
    }
    const now = Math.floor(this.clock() / 1000);
    if (claims.typ !== "sourx-capability" || claims.aud !== "sourx-gateway") throw new DomainError("INVALID_TOKEN", "token audience 无效");
    if (claims.expiresAt <= now || claims.issuedAt > now + 30) throw new DomainError("INVALID_TOKEN", "token 已过期或尚未生效");
    if (options.requiredScope && !claims.scopes.includes(options.requiredScope)) throw new DomainError("TOKEN_SCOPE_DENIED", "token 没有所需权限");
    if (options.orderId && claims.orderId !== options.orderId) throw new DomainError("TOKEN_RESOURCE_DENIED", "token 不能访问该订单");
    if (options.leaseId && claims.leaseId !== options.leaseId) throw new DomainError("TOKEN_RESOURCE_DENIED", "token 不能访问该租约");
    if (options.expectedVersion !== undefined && claims.version !== options.expectedVersion) throw new DomainError("TOKEN_REVOKED", "token 已被撤销");
    return claims;
  }
}

export type AgentCommandType = "prepare_sandbox" | "start_sandbox" | "stop_sandbox" | "destroy_sandbox";

export interface AgentCommandPayload {
  sandboxId: string;
  leaseId: string;
  [key: string]: unknown;
}

export interface SignedAgentCommand {
  id: string;
  type: AgentCommandType;
  expiresAt: number;
  payload: AgentCommandPayload;
  signature: string;
}

export class AgentCommandSigner {
  public constructor(private readonly secret: string, private readonly clock: () => number = () => Date.now()) {
    if (secret.length < 32) throw new Error("Agent 命令密钥至少需要 32 个字符");
  }

  public sign(input: Omit<SignedAgentCommand, "id" | "signature">): SignedAgentCommand {
    const command = { id: randomUUID(), ...input };
    const encoded = encode(JSON.stringify(command));
    return { ...command, signature: mac(this.secret, encoded) };
  }

  public verify(command: SignedAgentCommand): SignedAgentCommand {
    const unsigned = { id: command.id, type: command.type, expiresAt: command.expiresAt, payload: command.payload };
    const encoded = encode(JSON.stringify(unsigned));
    if (!equalMac(mac(this.secret, encoded), command.signature)) throw new DomainError("INVALID_COMMAND", "Agent 命令签名无效");
    if (command.expiresAt <= Math.floor(this.clock() / 1000)) throw new DomainError("EXPIRED_COMMAND", "Agent 命令已过期");
    return command;
  }
}

