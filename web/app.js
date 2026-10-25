const state = { overview: null, capability: null, job: null };
const $ = (id) => document.getElementById(id);
const money = (minor) => `¥${(minor / 100).toFixed(2)}`;
const time = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';

function toast(message, error = false) {
  const node = $('toast'); node.textContent = message; node.style.borderColor = error ? 'var(--red)' : 'var(--cyan)'; node.classList.add('show');
  window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => node.classList.remove('show'), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error?.message || `请求失败 (${response.status})`);
  return body;
}

function actor(role) { return state.overview?.users?.[role]?.id || ''; }

function render(data) {
  state.overview = data;
  const { node, listing, order, lease, payment, metering } = data;
  const gpu = node.gpus.find((item) => item.id === listing.gpuId) || node.gpus[0];
  $('metricGpu').textContent = `${node.gpus.length} / 1`;
  $('metricEscrow').textContent = money(order.totalAmountMinor);
  $('metricLease').textContent = lease.status === 'ready' || lease.status === 'running' ? '1 活跃' : '已结束';
  $('listingModel').textContent = gpu.model;
  $('listingMeta').textContent = `${node.region} · ${node.id.slice(0, 16)}… · Agent ${node.agentVersion}`;
  $('listingVram').textContent = `${Math.round(gpu.vramMb / 1024)} GB`;
  $('listingCuda').textContent = `CUDA ${gpu.cudaVersion}`;
  $('listingBenchmark').textContent = gpu.benchmarkScore.toLocaleString('en-US');
  $('listingPrice').textContent = money(listing.pricePerHourMinor);
  $('nodeRegion').textContent = node.region;
  $('nodeHeartbeat').textContent = `心跳 ${time(node.lastHeartbeatAt)}`;
  $('orderId').textContent = order.id;
  $('orderStatus').textContent = ({ active: '租约运行中', completed: '订单已完成', ending: '正在清理', paid: '等待启动' })[order.status] || order.status;
  $('orderDuration').textContent = `${order.durationMinutes} 分钟`;
  $('orderCompute').textContent = money(order.computeAmountMinor);
  $('orderFee').textContent = money(order.platformFeeMinor);
  $('orderTotal').textContent = money(order.totalAmountMinor);
  $('leaseStatus').textContent = lease.status;
  $('sandboxId').textContent = lease.sandboxId || '已销毁';
  $('billableSeconds').textContent = `${metering?.billableSeconds || 0} 秒`;
  $('endOrderButton').disabled = !['active', 'paid', 'allocating'].includes(order.status);
  $('jobButton').disabled = !['ready', 'running'].includes(lease.status);
  $('lastEvent').textContent = `订单 ${order.id} · payment ${payment.status} · capability 绑定 ${lease.id}`;
  $('lastRefresh').textContent = `刷新于 ${time(new Date().toISOString())}`;
  if (state.job) $('jobOutput').textContent = JSON.stringify(state.job, null, 2);
}

async function refresh(showToast = false) {
  try {
    const current = state.overview;
    const headers = current ? { 'x-user-id': actor('buyer') } : {};
    const data = await api('/v1/demo/overview', { headers });
    render(data);
    if (showToast) toast('平台状态已刷新');
  } catch (error) { toast(error.message, true); }
}

async function meter() {
  try {
    const { lease, node } = state.overview;
    await api(`/v1/agent/leases/${lease.id}/meter`, { method: 'POST', headers: { 'x-user-id': actor('provider') }, body: JSON.stringify({ observedAtEpoch: Math.floor(Date.now() / 1000), heartbeat: true, sandboxState: 'running', gpuUuid: node.gpus[0].uuid }) });
    await refresh(); toast('已记录卖家 Agent 心跳和 GPU 计量');
  } catch (error) { toast(error.message, true); }
}

async function submitJob() {
  const button = $('jobButton'); button.disabled = true;
  try {
    const { order, lease, listing } = state.overview;
    if (!state.capability) state.capability = await api(`/v1/orders/${order.id}/capability`, { headers: { 'x-user-id': actor('buyer') } });
    state.job = await api('/v1/gateway/jobs', { method: 'POST', headers: { authorization: `Bearer ${state.capability.token}` }, body: JSON.stringify({ orderId: order.id, leaseId: lease.id, imageDigest: listing.imageDigests[0], command: ['python', '-c', "print('SourX isolated workload ready')"], inputArtifactIds: [], maxRuntimeSeconds: 120 }) });
    $('jobOutput').textContent = JSON.stringify(state.job, null, 2); toast('任务已提交到订单级 Gateway');
  } catch (error) { state.capability = null; toast(error.message, true); } finally { button.disabled = false; render(state.overview); }
}

async function showCapability() {
  try {
    if (!state.capability) state.capability = await api(`/v1/orders/${state.overview.order.id}/capability`, { headers: { 'x-user-id': actor('buyer') } });
    toast(`Token 有效，剩余约 ${Math.max(0, state.capability.expiresAt - Math.floor(Date.now() / 1000))} 秒，仅绑定当前订单`);
  } catch (error) { state.capability = null; toast(error.message, true); }
}

async function endOrder() {
  const button = $('endOrderButton'); button.disabled = true;
  try {
    const orderId = state.overview.order.id;
    await api(`/v1/orders/${orderId}/end`, { method: 'POST', headers: { 'x-user-id': actor('buyer') } });
    state.capability = null;
    const settlement = await api(`/v1/orders/${orderId}/settle`, { method: 'POST', headers: { 'x-user-id': actor('operator') } });
    await refresh();
    toast(`订单已清理并结算，卖家应收 ${money(settlement.providerPayoutMinor)}`);
  } catch (error) { button.disabled = false; toast(error.message, true); }
}

$('refreshButton').addEventListener('click', () => refresh(true));
$('meterButton').addEventListener('click', meter);
$('jobButton').addEventListener('click', submitJob);
$('capabilityButton').addEventListener('click', showCapability);
$('endOrderButton').addEventListener('click', endOrder);
refresh();
