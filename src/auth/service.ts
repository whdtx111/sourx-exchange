import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { MarketplaceService } from "../domain/service.js";
import type { User, UserRole } from "../domain/types.js";

interface Account {
  userId: string;
  passwordHash: string;
}

interface Session {
  userId: string;
  accessJti: string;
  accessExpiresAt: number;
  refreshHash: string;
  refreshExpiresAt: number;
  revoked: boolean;
}

interface AccessClaims {
  typ: "sourx-access";
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  user: User;
}

export class AuthService {
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, Session>();

  public constructor(
    private readonly marketplace: MarketplaceService,
    private readonly secret: string,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (secret.length < 32) throw new Error("auth secret 至少需要 32 个字符");
  }

  public register(identifier: string, password: string, role: Exclude<UserRole, "operator">): User {
    const key = this.normalizeIdentifier(identifier);
    this.validatePassword(password);
    if (this.accounts.has(key)) throw new DomainError("ACCOUNT_EXISTS", "账户已存在");
    const user = this.marketplace.createUser(role);
    this.accounts.set(key, { userId: user.id, passwordHash: this.hashPassword(password) });
    return user;
  }

  public login(identifier: string, password: string): AuthTokens {
    const account = this.accounts.get(this.normalizeIdentifier(identifier));
    if (!account || !this.verifyPassword(password, account.passwordHash)) throw new DomainError("INVALID_CREDENTIALS", "账户或密码错误");
    return this.issueSession(account.userId);
  }

  public refresh(refreshToken: string): AuthTokens {
    const tokenHash = digest(refreshToken);
    const session = [...this.sessions.values()].find((candidate) => candidate.refreshHash === tokenHash && !candidate.revoked);
    if (!session || session.refreshExpiresAt <= this.nowSeconds()) throw new DomainError("INVALID_REFRESH_TOKEN", "refresh token 无效或已过期");
    session.revoked = true;
    return this.issueSession(session.userId);
  }

  public verifyAccess(token: string): User {
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra) throw new DomainError("UNAUTHENTICATED", "access token 格式不合法");
    const expected = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new DomainError("UNAUTHENTICATED", "access token 签名无效");
    let claims: AccessClaims;
    try {
      claims = JSON.parse(decode(encoded)) as AccessClaims;
    } catch {
      throw new DomainError("UNAUTHENTICATED", "access token 内容无效");
    }
    const session = this.sessions.get(claims.jti);
    if (claims.typ !== "sourx-access" || !session || session.revoked || session.userId !== claims.sub || session.accessExpiresAt !== claims.exp || claims.exp <= this.nowSeconds()) {
      throw new DomainError("UNAUTHENTICATED", "access token 已失效");
    }
    const user = this.marketplace.requireUser(claims.sub);
    if (user.status !== "active") throw new DomainError("ACCOUNT_SUSPENDED", "账户已被停用");
    return user;
  }

  public logout(token: string): void {
    const [encoded] = token.split(".");
    if (!encoded) return;
    try {
      const claims = JSON.parse(decode(encoded)) as AccessClaims;
      const session = this.sessions.get(claims.jti);
      if (session) session.revoked = true;
    } catch {
      // Logout is idempotent for malformed or already expired access tokens.
    }
  }

  private issueSession(userId: string): AuthTokens {
    const now = this.nowSeconds();
    const accessExpiresAt = now + 15 * 60;
    const refreshExpiresAt = now + 30 * 24 * 60 * 60;
    const accessJti = randomUUID();
    const refreshToken = randomBytes(32).toString("base64url");
    this.sessions.set(accessJti, { userId, accessJti, accessExpiresAt, refreshHash: digest(refreshToken), refreshExpiresAt, revoked: false });
    const claims: AccessClaims = { typ: "sourx-access", sub: userId, jti: accessJti, iat: now, exp: accessExpiresAt };
    const encoded = encode(JSON.stringify(claims));
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return { accessToken: `${encoded}.${signature}`, refreshToken, accessExpiresAt, user: this.marketplace.requireUser(userId) };
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
  }

  private verifyPassword(password: string, encoded: string): boolean {
    const [salt, expectedHex] = encoded.split(":");
    if (!salt || !expectedHex) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private validatePassword(password: string): void {
    if (password.length < 12 || password.length > 256) throw new DomainError("PASSWORD_INVALID", "密码长度必须为 12 到 256 个字符");
  }

  private normalizeIdentifier(identifier: string): string {
    const normalized = identifier.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw new DomainError("IDENTIFIER_INVALID", "登录标识必须是合法邮箱");
    return normalized;
  }

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }
}
