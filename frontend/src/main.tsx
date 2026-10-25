import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Role = "buyer" | "provider" | "operator";
type Overview = {
  users: Record<Role, { id: string }>;
  node: { id: string; region: string; agentVersion: string; lastHeartbeatAt: string | null; gpus: Array<{ id: string; uuid: string; model: string; vramMb: number; cudaVersion: string; benchmarkScore: number }> };
  listing: { id: string; gpuId: string; pricePerHourMinor: number; minimumMinutes: number; imageDigests: string[] };
  order: { id: string; durationMinutes: number; computeAmountMinor: number; platformFeeMinor: number; totalAmountMinor: number; status: string };
  payment: { status: string };
  lease: { id: string; status: string; sandboxId: string | null };
  metering: { billableSeconds: number };
  security: { capabilityScopes: string[]; hostMounts: boolean; hostNetwork: boolean; rootFilesystemReadOnly: boolean; orderScoped: boolean };
};
type Capability = { token: string; expiresAt: number; orderId: string; leaseId: string };
type Job = { id: string; status: string; imageDigest: string; command: string[]; createdAt: string; maxRuntimeSeconds: number };

const money = (minor: number) => `¥${(minor / 100).toFixed(2)}`;
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
const shortId = (value: string) => `${value.slice(0, 12)}…`;

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers ?? {}) },
  });
  const body = response.status === 204 ? null : await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `请求失败 (${response.status})`);
  return body as T;
}

function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>("");

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const loadOverview = useCallback(async (showMessage = false) => {
    try {
      const data = await api<Overview>("/v1/demo/overview");
      setOverview(data);
      setLastRefresh(new Date().toISOString());
      if (showMessage) notify("控制面状态已刷新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "读取平台状态失败", true);
    }
  }, [notify]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const gpu = useMemo(() => {
    if (!overview) return null;
    return overview.node.gpus.find((item) => item.id === overview.listing.gpuId) ?? overview.node.gpus[0];
  }, [overview]);

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    try { await action(); } catch (error) { notify(error instanceof Error ? error.message : "操作失败", true); } finally { setBusy(null); }
  }

  if (!overview || !gpu) {
    return <div className="loading-screen"><div className="brand-mark">SX</div><p>正在连接 SourX 控制面…</p></div>;
  }

  const activeLease = ["ready", "running"].includes(overview.lease.status);
  const orderCanEnd = ["active", "paid", "allocating"].includes(overview.order.status);
  const statusLabel: Record<string, string> = { active: "租约运行中", paid: "已托管，等待启动", completed: "订单已完成", ending: "正在清理", refunded: "已退款" };

  const meter = () => runAction("meter", async () => {
    await api(`/v1/agent/leases/${overview.lease.id}/meter`, {
      method: "POST",
      headers: { "x-user-id": overview.users.provider.id },
      body: JSON.stringify({ observedAtEpoch: Math.floor(Date.now() / 1000), heartbeat: true, sandboxState: "running", gpuUuid: gpu.uuid }),
    });
    await loadOverview();
    notify("已记录卖家 Agent 心跳和 GPU 计量");
  });

  const getCapability = async () => {
    if (capability) {
      const remaining = Math.max(0, capability.expiresAt - Math.floor(Date.now() / 1000));
      notify(`Token 有效，剩余约 ${remaining} 秒，仅绑定当前订单`);
      return capability;
    }
    const next = await api<Capability>(`/v1/orders/${overview.order.id}/capability`, { headers: { "x-user-id": overview.users.buyer.id } });
    setCapability(next);
    notify("已签发订单级 capability token");
    return next;
  };

  const submitJob = () => runAction("job", async () => {
    const token = (await getCapability()).token;
    const next = await api<Job>("/v1/gateway/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ orderId: overview.order.id, leaseId: overview.lease.id, imageDigest: overview.listing.imageDigests[0], command: ["python", "-c", "print('SourX isolated workload ready')"], inputArtifactIds: [], maxRuntimeSeconds: 120 }),
    });
    setJob(next);
    notify("任务已进入订单级 Gateway 队列");
  });

  const endOrder = () => runAction("end", async () => {
    await api(`/v1/orders/${overview.order.id}/end`, { method: "POST", headers: { "x-user-id": overview.users.buyer.id } });
    setCapability(null);
    const settlement = await api<{ providerPayoutMinor: number }>(`/v1/orders/${overview.order.id}/settle`, { method: "POST", headers: { "x-user-id": overview.users.operator.id } });
    await loadOverview();
    notify(`订单已清理并结算，卖家应收 ${money(settlement.providerPayoutMinor)}`);
  });

  return <div className="app-shell">
    <aside className="rail">
      <a className="brand" href="#top" aria-label="SourX Exchange 首页"><span className="brand-mark">SX</span><span><strong>SourX</strong><small>EXCHANGE</small></span></a>
      <nav className="rail-nav" aria-label="主导航">
        <a className="active" href="#overview"><span>◈</span>控制台</a>
        <a href="#market"><span>⌁</span>算力市场</a>
        <a href="#order"><span>▣</span>我的订单</a>
        <a href="#boundary"><span>◇</span>安全边界</a>
      </nav>
      <div className="rail-footer"><span className="online-dot" />演示环境<strong>API 在线</strong></div>
    </aside>
    <main id="top" className="main-content">
      <header className="topbar"><div><p className="eyebrow">COMPUTE CONTROL PLANE / 01</p><h1 id="overview">把闲置 GPU 变成可验证的生产力。</h1></div><div className="top-actions"><span className="role-chip">买家视角</span><button className="icon-button" onClick={() => void loadOverview(true)} aria-label="刷新平台状态" title="刷新平台状态">↻</button></div></header>

      <section className="signal-row" aria-label="平台摘要"><div className="signal-copy"><span className="signal-kicker">LIVE MARKET</span><strong>订单、计量、结算都在同一条链路内。</strong><span>当前演示节点由卖家 Agent 纳管，买家拿到的只有本订单临时工作区。</span></div><div className="uptime"><strong>98.7<small>%</small></strong><span>节点过去 24 小时在线率</span></div><div className="sync"><span className="online-dot" />已同步<span>{lastRefresh ? time(lastRefresh) : "--"}</span></div></section>

      <section className="metric-grid" aria-label="平台概览"><Metric label="可用 GPU" value={`${overview.node.gpus.length} / 1`} note="已纳管节点" tone="cyan" /><Metric label="托管金额" value={money(overview.order.totalAmountMinor)} note="订单完成后结算" tone="amber" /><Metric label="当前租约" value={activeLease ? "1 活跃" : "已结束"} note="订单级权限" tone="lime" /><Metric label="隔离策略" value="7 项" note="沙箱与出口均受限" /></section>

      <section className="workspace-grid">
        <article id="market" className="surface listing-surface"><SectionHeading eyebrow="MARKETPLACE" title="算力商品" meta="实时" /><div className="listing-body"><div className="gpu-card"><span>BLACKWELL</span><strong>5090</strong><small>RTX / 32 GB GDDR7</small><i>GPU</i></div><div className="listing-details"><div className="listing-title"><h2>{gpu.model}</h2><span className="status-pill">在线</span></div><p className="mono muted">{overview.node.region} · {shortId(overview.node.id)} · Agent {overview.node.agentVersion}</p><div className="spec-grid"><Spec label="显存" value={`${Math.round(gpu.vramMb / 1024)} GB`} /><Spec label="CUDA" value={gpu.cudaVersion} /><Spec label="基准分" value={gpu.benchmarkScore.toLocaleString("en-US")} /></div><div className="listing-price"><div><strong>{money(overview.listing.pricePerHourMinor)}</strong><span>/ GPU 小时 · 起租 {overview.listing.minimumMinutes} 分钟</span></div><button className="secondary-button" disabled={busy === "meter"} onClick={meter}>{busy === "meter" ? "上报中…" : "上报心跳"}</button></div></div></div><div className="availability"><span><i className="online-dot" />卖家节点在线</span><span>{overview.node.region}</span><span>最近心跳 {time(overview.node.lastHeartbeatAt)}</span></div></article>

        <article id="order" className="surface order-surface"><SectionHeading eyebrow="ESCROW ORDER" title="托管订单" meta={shortId(overview.order.id)} /><div className="order-state"><span className="state-icon">✓</span><div><strong>{statusLabel[overview.order.status] ?? overview.order.status}</strong><span>{overview.payment.status === "authorized" ? "款项已锁定在平台托管账户" : `支付状态：${overview.payment.status}`}</span></div></div><div className="order-lines"><Line label="租用时长" value={`${overview.order.durationMinutes} 分钟`} /><Line label="算力费用" value={money(overview.order.computeAmountMinor)} /><Line label="平台服务费" value={money(overview.order.platformFeeMinor)} strong /><Line label="买家已托管" value={money(overview.order.totalAmountMinor)} total /></div><button className="primary-button" disabled={!orderCanEnd || busy === "end"} onClick={endOrder}>{busy === "end" ? "清理与结算中…" : "结束租约并结算"}</button><p className="helper">结束后自动撤销 token、取消任务、销毁临时工作区并释放 GPU。</p></article>
      </section>

      <section className="workspace-grid lower">
        <article className="surface workload-surface"><SectionHeading eyebrow="WORKLOAD GATEWAY" title="订单内任务" meta="ORDER SCOPED" /><div className="lease-strip"><Info label="租约状态" value={overview.lease.status} /><Info label="Sandbox" value={overview.lease.sandboxId ? shortId(overview.lease.sandboxId) : "已销毁"} /><Info label="计量时长" value={`${overview.metering.billableSeconds} 秒`} /></div><div className="job-console"><div className="console-header"><span><i /><i /><i /></span><small>buyer / gateway / isolated</small></div><pre>{job ? JSON.stringify(job, null, 2) : "等待提交任务…\n\n任务会以订单级 token 进入队列。"}</pre></div><div className="action-row"><button className="primary-button" disabled={!activeLease || busy === "job"} onClick={submitJob}>{busy === "job" ? "提交中…" : "获取权限并提交示例任务"}</button><button className="ghost-button" disabled={!activeLease || busy === "capability"} onClick={() => void runAction("capability", async () => { await getCapability(); })}>{capability ? "Token 已签发" : "查看 Token 状态"}</button></div></article>
        <article id="boundary" className="surface security-surface"><SectionHeading eyebrow="BOUNDARY CHECK" title="访问边界" meta="ENFORCED" /><p className="security-copy">买家只通过短时 capability token 调用 Gateway，平台不会把卖家工作区或宿主机暴露给订单。</p><SecurityRow title="临时工作区" detail="订单结束自动销毁" status="允许" /><SecurityRow title="宿主磁盘 / 工作区" detail="无挂载、只读根文件系统" status="拒绝" /><SecurityRow title="Docker socket / 内网" detail="网络隔离并阻断 metadata" status="拒绝" /><SecurityRow title="跨订单数据" detail="token 绑定 orderId + leaseId" status="拒绝" /></article>
      </section>
      <div className="audit-bar"><span className="eyebrow">AUDIT TRAIL</span><span>订单 {shortId(overview.order.id)} · payment {overview.payment.status} · capability {capability ? "已签发" : "未签发"}</span><span className="mono muted">{lastRefresh ? time(lastRefresh) : "--"}</span></div>
      <footer><span>SourX Exchange / control plane</span><span>内存 Demo · 模拟支付 · 真实 API 边界</span></footer>
    </main>
    {toast && <div className={`toast ${toast.error ? "error" : ""}`} role="status" aria-live="polite">{toast.message}</div>}
  </div>;
}

function Metric({ label, value, note, tone = "" }: { label: string; value: string; note: string; tone?: string }) { return <article className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function SectionHeading({ eyebrow, title, meta }: { eyebrow: string; title: string; meta: string }) { return <div className="section-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span className="section-meta">{meta}</span></div>; }
function Spec({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Line({ label, value, strong = false, total = false }: { label: string; value: string; strong?: boolean; total?: boolean }) { return <div className={total ? "total" : ""}><span>{label}</span><strong className={strong ? "amber-text" : ""}>{value}</strong></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function SecurityRow({ title, detail, status }: { title: string; detail: string; status: string }) { return <div className="security-row"><span className="check">✓</span><div><strong>{title}</strong><small>{detail}</small></div><b className={status === "允许" ? "allow" : "deny"}>{status}</b></div>; }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
