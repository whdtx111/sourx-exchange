import { describe, expect, it } from "vitest";
import { EnrollmentCodeStore } from "../src/agent/enrollment.js";
import { AgentCommandSigner, CapabilityTokenService } from "../src/agent/security.js";
import { AgentCommandExecutor, InMemorySandboxRuntime, type SandboxSpec } from "../src/agent/sandbox.js";
import { AgentCommandQueue } from "../src/agent/commands.js";

const secret = "test-secret-that-is-longer-than-32-characters";
const imageDigest = "sha256:" + "c".repeat(64);
const spec = (): SandboxSpec => ({
  sandboxId: "sandbox-1",
  leaseId: "lease-1",
  gpuUuid: "GPU-1",
  imageDigest,
  command: ["python", "/workspace/main.py"],
  workspaceQuotaMb: 1024,
  environment: { JOB_ID: "job-1" },
  networkMode: "isolated",
  hostPid: false,
  hostIpc: false,
  hostNetwork: false,
  readOnlyRootFilesystem: true,
  privileged: false,
  hostMounts: [],
  dropCapabilities: ["ALL"],
  pidsLimit: 256,
  memoryLimitMb: 4096,
  cpuLimitMilli: 2000,
  containerUser: "1000:1000",
  allowlistedEgress: ["https://objects.example.com"],
});

describe("Agent enrollment and security boundaries", () => {
  it("注册码只能消费一次并且会过期", () => {
    let clock = 1_000;
    const store = new EnrollmentCodeStore(() => clock);
    const code = store.issue("provider-1", 100);
    expect(store.consume(code).providerId).toBe("provider-1");
    expect(() => store.consume(code)).toThrowError(/无效/);
    const expired = store.issue("provider-2", 100);
    clock = 1_101;
    expect(() => store.consume(expired)).toThrowError(/无效/);
  });

  it("capability token 绑定订单、租约、scope 和版本，版本变化后撤销", () => {
    let clock = 1_000_000;
    const tokens = new CapabilityTokenService(secret, () => clock * 1000);
    const token = tokens.issue({ subject: "buyer-1", orderId: "order-1", leaseId: "lease-1", scopes: ["job:create", "artifact:read"], version: 1, expiresAt: clock + 60 });
    expect(tokens.verify(token, { requiredScope: "job:create", orderId: "order-1", leaseId: "lease-1", expectedVersion: 1 }).subject).toBe("buyer-1");
    expect(() => tokens.verify(token, { requiredScope: "job:cancel" })).toThrowError(/权限/);
    expect(() => tokens.verify(token, { expectedVersion: 2 })).toThrowError(/撤销/);
    clock += 61;
    expect(() => tokens.verify(token)).toThrowError(/过期/);
  });

  it("Agent 命令必须签名且不能执行过期命令", () => {
    let clock = 1_000;
    const signer = new AgentCommandSigner(secret, () => clock * 1000);
    const command = signer.sign({ type: "start_sandbox", expiresAt: 1_010, payload: { sandboxId: "sandbox-1", leaseId: "lease-1" } });
    expect(signer.verify(command).type).toBe("start_sandbox");
    expect(() => signer.verify({ ...command, type: "destroy_sandbox" })).toThrowError(/签名/);
    clock = 1_011;
    expect(() => signer.verify(command)).toThrowError(/过期/);
  });

  it("sandbox 拒绝宿主挂载、root、特权和非白名单镜像", () => {
    const runtime = new InMemorySandboxRuntime([imageDigest]);
    const executor = new AgentCommandExecutor(runtime, [imageDigest]);
    expect(executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1", spec: spec() } }).status).toBe("ready");
    expect(() => executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-2", leaseId: "lease-2", spec: { ...spec(), sandboxId: "sandbox-2", leaseId: "lease-2", hostMounts: ["/Users/seller:/workspace"] as never[] } } })).toThrowError(/宿主机目录/);
    expect(() => executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-3", leaseId: "lease-3", spec: { ...spec(), sandboxId: "sandbox-3", leaseId: "lease-3", containerUser: "root" } } })).toThrowError(/root/);
    expect(() => executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-4", leaseId: "lease-4", spec: { ...spec(), sandboxId: "sandbox-4", leaseId: "lease-4", imageDigest: "sha256:" + "d".repeat(64) } } })).toThrowError(/白名单/);
    expect(() => executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-5", leaseId: "lease-5", spec: { ...spec(), sandboxId: "sandbox-5", leaseId: "lease-5", hostNetwork: true } } })).toThrowError(/namespace/);
    expect(() => executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-6", leaseId: "lease-6", spec: { ...spec(), sandboxId: "sandbox-6", leaseId: "lease-6", allowlistedEgress: ["http://169.254.169.254/latest/meta-data"] } } })).toThrowError(/metadata/);
  });

  it("sandbox 只能按固定生命周期停止和销毁", () => {
    const runtime = new InMemorySandboxRuntime([imageDigest]);
    const executor = new AgentCommandExecutor(runtime, [imageDigest]);
    executor.execute({ type: "prepare_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1", spec: spec() } });
    executor.execute({ type: "start_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1" } });
    expect(() => executor.execute({ type: "destroy_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1" } })).toThrowError(/运行中的/);
    expect(executor.execute({ type: "stop_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1" } }).status).toBe("stopping");
    expect(executor.execute({ type: "destroy_sandbox", payload: { sandboxId: "sandbox-1", leaseId: "lease-1" } }).status).toBe("destroyed");
  });

  it("Agent 命令队列只下发签名命令并要求同一节点确认", () => {
    const queue = new AgentCommandQueue(new AgentCommandSigner(secret), () => 1_000_000);
    const command = queue.enqueue("node-1", "stop_sandbox", { sandboxId: "sandbox-1", leaseId: "lease-1" });
    expect(queue.pull("node-1")).toHaveLength(1);
    expect(() => queue.acknowledge("node-2", command.id, "succeeded")).toThrowError(/不存在/);
    expect(queue.acknowledge("node-1", command.id, "succeeded").status).toBe("succeeded");
    expect(queue.getAck(command.id)?.nodeId).toBe("node-1");
  });
});

