import { DomainError, notFound } from "../domain/errors.js";
import { AgentCommandSigner, type AgentCommandPayload, type AgentCommandType, type SignedAgentCommand } from "./security.js";

interface QueuedCommand {
  nodeId: string;
  command: SignedAgentCommand;
  delivered: boolean;
}

export interface CommandAck {
  commandId: string;
  nodeId: string;
  status: "succeeded" | "failed";
  message: string | null;
  acknowledgedAt: string;
}

export class AgentCommandQueue {
  private readonly commands = new Map<string, QueuedCommand>();
  private readonly pendingByNode = new Map<string, string[]>();
  private readonly acks = new Map<string, CommandAck>();

  public snapshot() { return {commands: [...this.commands.entries()], pendingByNode: [...this.pendingByNode.entries()], acks: [...this.acks.entries()]}; }
  public restore(data: ReturnType<AgentCommandQueue["snapshot"]> | undefined) {
    if (!data) return;
    for (const [key,value] of data.commands) this.commands.set(key,value);
    for (const [key,value] of data.pendingByNode) this.pendingByNode.set(key,value);
    for (const [key,value] of data.acks) this.acks.set(key,value);
  }

  public constructor(private readonly signer: AgentCommandSigner, private readonly clock: () => number = () => Date.now()) {}

  public enqueue(nodeId: string, type: AgentCommandType, payload: AgentCommandPayload, ttlSeconds = 60): SignedAgentCommand {
    if (ttlSeconds <= 0 || ttlSeconds > 15 * 60) throw new DomainError("INVALID_COMMAND_TTL", "Agent 命令有效期不合法");
    const command = this.signer.sign({ type, expiresAt: Math.floor(this.clock() / 1000) + ttlSeconds, payload });
    this.commands.set(command.id, { nodeId, command, delivered: false });
    const pending = this.pendingByNode.get(nodeId) ?? [];
    pending.push(command.id);
    this.pendingByNode.set(nodeId, pending);
    return command;
  }

  public pull(nodeId: string): SignedAgentCommand[] {
    const ids = this.pendingByNode.get(nodeId) ?? [];
    this.pendingByNode.set(nodeId, []);
    const result: SignedAgentCommand[] = [];
    for (const id of ids) {
      const queued = this.commands.get(id);
      if (!queued || queued.command.expiresAt <= Math.floor(this.clock() / 1000)) continue;
      queued.delivered = true;
      result.push(queued.command);
    }
    return result;
  }

  public acknowledge(nodeId: string, commandId: string, status: "succeeded" | "failed", message: string | null = null): CommandAck {
    const queued = this.commands.get(commandId);
    if (!queued || queued.nodeId !== nodeId) throw notFound("Agent 命令");
    if (!queued.delivered) throw new DomainError("COMMAND_NOT_DELIVERED", "命令尚未下发，不能确认");
    const ack: CommandAck = { commandId, nodeId, status, message, acknowledgedAt: new Date(this.clock()).toISOString() };
    this.acks.set(commandId, ack);
    this.commands.delete(commandId);
    return ack;
  }

  public getAck(commandId: string): CommandAck | undefined {
    return this.acks.get(commandId);
  }
}
