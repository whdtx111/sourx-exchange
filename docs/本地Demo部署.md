# SourX Exchange 本地 Demo 部署

本目录提供第一版推荐方案的可运行演示：一个 Fastify 控制面容器同时提供 API 和 React + Vite 构建的前端，启动后可在浏览器完成算力商品查看、托管订单、租约、Agent 计量、订单级 capability token 和隔离任务提交。

## 启动

在仓库根目录执行：

```bash
docker compose up --build -d
```

查看容器状态：

```bash
docker compose ps
docker compose logs -f sourx-exchange
```

## 访问

- 前端 Demo：<http://localhost:3000>
- 后端健康检查：<http://localhost:3000/health>
- Demo 状态 API：<http://localhost:3000/v1/demo/overview>

页面首次加载会由 `DEMO_MODE=true` 自动创建买家、卖家、运营方、RTX 5090 节点、已发布商品和一笔已完成支付授权的 60 分钟订单。数据存放在内存中，重启容器会重新生成一套演示数据。

## 页面操作

1. 点击“上报一次心跳”验证卖家 Agent 的 GPU UUID 和计量入口。
2. 点击“查看 Token 状态”签发当前订单的短时 capability token。
3. 点击“获取权限并提交示例任务”调用订单级 Gateway。任务只使用白名单镜像和临时工作区。
4. 点击“结束租约并结算”执行清理：取消任务、撤销 token、销毁 sandbox、删除 artifact 并释放 GPU。

## 当前 Demo 边界

- 订单、支付、计量和结算是内存实现；支付授权使用模拟 provider reference。
- Agent、反向隧道、Docker/NVIDIA runtime、PostgreSQL、Redis、S3 和真实支付分账尚未接入。示例 Job 会进入平台队列，但当前不会在真实 GPU 上执行。
- `ALLOW_DEV_AUTH_BYPASS` 和 `/v1/users` 仅为本地演示便利，生产环境必须关闭，并配置独立密钥和真实身份服务。
- 买家不会获得卖家宿主机目录、工作区、Docker socket、host namespace 或内网访问权限；只可在订单租约有效期间使用 Gateway 暴露的 Job 与 Artifact 接口。

## 停止

```bash
docker compose down
```
