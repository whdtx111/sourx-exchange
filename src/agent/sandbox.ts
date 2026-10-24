import { DomainError } from "../domain/errors.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export interface SandboxSpec {
  sandboxId: string;
  leaseId: string;
  gpuUuid: string;
  imageDigest: string;
  command: string[];
  workspaceQuotaMb: number;
  environment: Record<string, string>;
  networkMode: "isolated";
  hostPid: false;
  hostIpc: false;
  hostNetwork: false;
  readOnlyRootFilesystem: true;
  privileged: false;
  hostMounts: never[];
  dropCapabilities: string[];
  pidsLimit: number;
  memoryLimitMb: number;
  cpuLimitMilli: number;
  containerUser: string;
  allowlistedEgress: string[];
}

export type SandboxStatus = "creating" | "ready" | "running" | "stopping" | "destroyed";

export interface SandboxRecord {
  spec: SandboxSpec;
  status: SandboxStatus;
  createdAt: string;
  destroyedAt: string | null;
}

export const validateSandboxSpec = (spec: SandboxSpec, allowedImages: readonly string[]): void => {
  if (!spec.sandboxId || !spec.leaseId || !spec.gpuUuid) throw new DomainError("INVALID_SANDBOX", "sandbox 标识不完整");
  if (!digestPattern.test(spec.imageDigest) || !allowedImages.includes(spec.imageDigest)) throw new DomainError("IMAGE_NOT_ALLOWED", "镜像不在平台白名单中");
  if (spec.networkMode !== "isolated") throw new DomainError("NETWORK_POLICY_DENIED", "sandbox 必须使用隔离网络");
  if (spec.hostPid || spec.hostIpc || spec.hostNetwork) throw new DomainError("HOST_NAMESPACE_DENIED", "禁止共享宿主机 namespace");
  if (!spec.readOnlyRootFilesystem) throw new DomainError("ROOT_FILESYSTEM_DENIED", "sandbox 根文件系统必须只读");
  if (spec.privileged !== false) throw new DomainError("PRIVILEGE_DENIED", "禁止特权 sandbox");
  if (spec.hostMounts.length !== 0) throw new DomainError("HOST_MOUNT_DENIED", "禁止宿主机目录挂载");
  if (!spec.dropCapabilities.includes("ALL")) throw new DomainError("CAPABILITY_DENIED", "sandbox 必须丢弃全部 Linux capabilities");
  if (spec.containerUser === "0" || spec.containerUser === "root") throw new DomainError("ROOT_USER_DENIED", "sandbox 不能使用 root 用户");
  if (spec.workspaceQuotaMb <= 0 || spec.workspaceQuotaMb > 1024 * 1024 || spec.pidsLimit <= 0 || spec.pidsLimit > 100_000 || spec.memoryLimitMb <= 0 || spec.cpuLimitMilli <= 0) throw new DomainError("RESOURCE_LIMIT_INVALID", "临时工作区资源配额不合法");
  if (spec.command.length === 0 || spec.command.some((part) => part.includes("\0"))) throw new DomainError("COMMAND_INVALID", "sandbox 入口命令不合法");
  if (spec.environment["SOURX_HOST_ROOT"] || spec.environment["DOCKER_HOST"]) throw new DomainError("SECRET_INJECTION_DENIED", "禁止注入宿主机或 Docker 控制变量");
  for (const endpoint of spec.allowlistedEgress) {
    let hostname: string;
    try {
      hostname = new URL(endpoint).hostname.toLowerCase();
    } catch {
      throw new DomainError("EGRESS_DENIED", "出口地址必须是合法 URL");
    }
    if (hostname === "localhost" || hostname === "metadata.google.internal" || hostname === "169.254.169.254" || hostname === "::1" || /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^(172\.(1[6-9]|2\d|3[0-1]))\./.test(hostname)) {
      throw new DomainError("EGRESS_DENIED", "禁止访问本机、内网或云 metadata 地址");
    }
  }
}

export interface SandboxRuntime {
  create(spec: SandboxSpec): SandboxRecord;
  start(sandboxId: string): SandboxRecord;
  stop(sandboxId: string): SandboxRecord;
  destroy(sandboxId: string): SandboxRecord;
  get(sandboxId: string): SandboxRecord | undefined;
}

export class InMemorySandboxRuntime implements SandboxRuntime {
  private readonly records = new Map<string, SandboxRecord>();

  public constructor(private readonly allowedImages: readonly string[]) {}

  public create(spec: SandboxSpec): SandboxRecord {
    validateSandboxSpec(spec, this.allowedImages);
    if (this.records.has(spec.sandboxId)) throw new DomainError("SANDBOX_EXISTS", "sandbox 已存在");
    const record: SandboxRecord = { spec, status: "ready", createdAt: new Date().toISOString(), destroyedAt: null };
    this.records.set(spec.sandboxId, record);
    return record;
  }

  public start(sandboxId: string): SandboxRecord {
    const record = this.require(sandboxId);
    if (record.status !== "ready") throw new DomainError("INVALID_SANDBOX_STATE", "sandbox 当前不能启动");
    record.status = "running";
    return record;
  }

  public stop(sandboxId: string): SandboxRecord {
    const record = this.require(sandboxId);
    if (record.status !== "running") throw new DomainError("INVALID_SANDBOX_STATE", "sandbox 当前不能停止");
    record.status = "stopping";
    return record;
  }

  public destroy(sandboxId: string): SandboxRecord {
    const record = this.require(sandboxId);
    if (record.status === "running" || record.status === "creating") throw new DomainError("SANDBOX_BUSY", "运行中的 sandbox 不能销毁");
    record.status = "destroyed";
    record.destroyedAt = new Date().toISOString();
    return record;
  }

  public get(sandboxId: string): SandboxRecord | undefined {
    return this.records.get(sandboxId);
  }

  private require(sandboxId: string): SandboxRecord {
    const record = this.records.get(sandboxId);
    if (!record) throw new DomainError("SANDBOX_NOT_FOUND", "sandbox 不存在");
    return record;
  }
}

export class AgentCommandExecutor {
  public constructor(private readonly runtime: SandboxRuntime, private readonly allowedImages: readonly string[]) {}

  public execute(command: { type: "prepare_sandbox" | "start_sandbox" | "stop_sandbox" | "destroy_sandbox"; payload: { sandboxId: string; leaseId: string; spec?: SandboxSpec } }): SandboxRecord {
    switch (command.type) {
      case "prepare_sandbox":
        if (!command.payload.spec) throw new DomainError("INVALID_COMMAND", "prepare_sandbox 缺少 spec");
        validateSandboxSpec(command.payload.spec, this.allowedImages);
        if (command.payload.spec.sandboxId !== command.payload.sandboxId || command.payload.spec.leaseId !== command.payload.leaseId) throw new DomainError("COMMAND_RESOURCE_MISMATCH", "命令资源与 sandbox spec 不匹配");
        return this.runtime.create(command.payload.spec);
      case "start_sandbox":
        return this.runtime.start(command.payload.sandboxId);
      case "stop_sandbox":
        return this.runtime.stop(command.payload.sandboxId);
      case "destroy_sandbox":
        return this.runtime.destroy(command.payload.sandboxId);
    }
  }
}

