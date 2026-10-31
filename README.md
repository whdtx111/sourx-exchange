# SourX Exchange

连接个人 PC、GPU 服务器与算力需求方的交易平台。买家按时租用指定 GPU 的计算能力，卖家管理设备和商品；买家不获得卖家主机、磁盘、工作目录或内网访问权。

前端 React + Vite，后端 TypeScript + Fastify。本地版已提供独立的买家工作台、卖家中心与运营台，使用真实登录和服务端角色/所有权校验。菜单进入独立页面，支持市场筛选、下单、测试支付、任务管理、订单清理、商品审核、收益与账单。

```bash
docker compose up --build -d
```

打开 <http://localhost:3000>。买家 `buyer@sourx.local`、卖家 `seller@sourx.local`、运营 `operator@sourx.local`；本地统一密码 `SourX.local2026!`。Compose 关闭开发身份绕过，账号和交易数据保存在命名卷中，重启可恢复。

真实支付渠道、真实 Linux/NVIDIA Agent 和 GPU 执行尚未接入；页面和接口明确显示本地测试能力。

- [本地部署与开发](docs/本地Demo部署.md)
- [角色交易平台设计与验收](docs/角色交易平台验收.md)
- [实现进度](docs/实现进度.md)
- [开发方案](docs/算力交易平台开发方案.md)
- [第一版详细开发计划](docs/第一版详细开发计划.md)

```bash
pnpm check
pnpm test:e2e
```
