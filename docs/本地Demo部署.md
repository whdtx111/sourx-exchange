# SourX 本地交易平台

更新：2026-10-31。前端 React + Vite，后端 Fastify；买家、卖家、运营使用各自账户和菜单。

## 启动与访问

```bash
pnpm install --frozen-lockfile
docker compose up --build -d
docker compose ps
```

- 平台入口：<http://localhost:3000>，未登录会进入登录页。
- 后端健康检查：<http://localhost:3000/health>。
- 买家：`buyer@sourx.local`。
- 卖家：`seller@sourx.local`。
- 运营：`operator@sourx.local`。
- 本地样例账号统一密码：`SourX.local2026!`。登录页可点击相应按钮填入后登录。

`studio@sourx.local` 是第二个独立卖家，使用相同本地密码，可验证彼此看不到对方设备和订单。也可通过登录页注册新的买家或卖家，查看空账户状态。

样例账号仅在 `DEMO_MODE=true` 且数据为空时创建。Compose 已关闭 `ALLOW_DEV_AUTH_BYPASS`，浏览器必须登录；不能再凭 `x-user-id` 执行操作。端口仅绑定本机 127.0.0.1。

## 功能使用

1. 买家登录后在市场搜索、筛选 GPU，进入详情，确认时长与访问规则后创建订单。
2. 在订单详情确认测试支付，平台模拟授权并准备独立租约，无真实扣款。
3. 进入任务空间提交 Python 任务，查看、刷新或取消任务。没有真实 GPU Agent 时任务停留队列，页面明确提示。
4. 订单详情“结束租约”会回收任务和权限，释放 GPU，并在本地账本记入有效计量和未用金额释放。
5. 卖家登录后可以暂停节点接单、创建/修改商品、上下架已审核商品、查看自己的租出订单及结算收益。
6. 新建或编辑的商品进入待审核，运营账号审核通过后才在市场出售。修改报价不影响历史订单。

## 持久化与重启

```bash
docker compose restart
```

账号、会话、订单、任务、计量和结算保存在 `sourx-data` 命名卷的 `/app/data/state.json`，重启或重建容器均保留。不要删除该卷来更新程序。

本地持久化是单实例实现，尚未替换为 PostgreSQL / Redis。支付、Agent Runtime、对象存储和真实 GPU 执行仍待接入。当前不是生产资金托管或生产隔离环境。

## 前后端开发

```bash
DEMO_MODE=true DATA_FILE=./data/state.json pnpm dev
pnpm dev:web
```

后端：3000；前端 Vite：5173，代理 `/v1` 与 `/health` 到后端。需要先释放 Docker 所占的 3000 端口。生产构建通过 `pnpm build`；后端将 `web-dist` 作为 SPA 提供，支持页面深链接。

## 验证

```bash
pnpm check
pnpm test:e2e
```

端到端测试使用本机安装的 Google Chrome，并需要已启动本地 Compose。测试会创建订单、编辑本地样例商品并通过运营审核，截图位于 `artifacts/`。

详细权限契约、页面分工和验收见 [角色交易平台验收](角色交易平台验收.md)。
