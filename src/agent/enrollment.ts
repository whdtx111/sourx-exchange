import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";

interface EnrollmentRecord {
  providerId: string;
  expiresAt: number;
  consumed: boolean;
}

export class EnrollmentCodeStore {
  private readonly records = new Map<string, EnrollmentRecord>();

  public constructor(private readonly clock: () => number = () => Date.now()) {}

  public issue(providerId: string, ttlMs = 10 * 60_000): string {
    if (ttlMs <= 0 || ttlMs > 60 * 60_000) throw new DomainError("INVALID_ENROLLMENT_TTL", "注册码有效期不合法");
    const code = randomBytes(24).toString("base64url");
    this.records.set(code, { providerId, expiresAt: this.clock() + ttlMs, consumed: false });
    return code;
  }

  public consume(code: string): { providerId: string } {
    const record = this.records.get(code);
    if (!record || record.consumed || record.expiresAt <= this.clock()) throw new DomainError("INVALID_ENROLLMENT", "注册码无效、已使用或已过期");
    record.consumed = true;
    return { providerId: record.providerId };
  }
}

