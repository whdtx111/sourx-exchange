export class DomainError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export const notFound = (resource: string): DomainError =>
  new DomainError("NOT_FOUND", `${resource} 不存在`);

export const forbidden = (message: string): DomainError =>
  new DomainError("FORBIDDEN", message);

