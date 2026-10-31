import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApp} from "../src/api/app.js";
import {MarketplaceService} from "../src/domain/service.js";
import {createStore} from "../src/domain/store.js";

const password="SourX.local2026!";
describe("角色门户、交易与恢复",()=>{
 const apps:ReturnType<typeof createApp>[]=[];const previous=process.env.DEMO_MODE;const dirs:string[]=[];
 beforeEach(()=>{process.env.DEMO_MODE="true";});
 afterEach(async()=>{await Promise.all(apps.splice(0).map((a)=>a.close()));for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=previous;});
 const setup=()=>{const service=new MarketplaceService(createStore()),app=createApp(service);apps.push(app);return {app,service};};
 const login=async(app:ReturnType<typeof createApp>,identifier:string)=>{
  const r=await app.inject({method:"POST",url:"/v1/auth/login",payload:{identifier,password}});expect(r.statusCode).toBe(200);return {authorization:`Bearer ${r.json().accessToken}`};
 };
 it("服务端拒绝跨角色与跨账号访问，卖家无法读取任务",async()=>{
  const{app}=setup();const buyer=await login(app,"buyer@sourx.local"),seller=await login(app,"seller@sourx.local"),other=await login(app,"studio@sourx.local");
  for(const url of ["/v1/provider/nodes","/v1/provider/listings","/v1/provider/orders","/v1/provider/earnings","/v1/operator/listings","/v1/operator/audit"])
   expect((await app.inject({url,headers:buyer})).statusCode).toBe(403);
  for(const url of ["/v1/buyer/orders","/v1/buyer/jobs"])expect((await app.inject({url,headers:seller})).statusCode).toBe(403);
  const owned=(await app.inject({url:"/v1/provider/nodes",headers:seller})).json().items;
  const notOwned=(await app.inject({url:"/v1/provider/nodes",headers:other})).json().items;
  expect(owned).toHaveLength(3);expect(notOwned).toHaveLength(3);
  expect((await app.inject({method:"PATCH",url:`/v1/provider/nodes/${notOwned[0].id}`,headers:seller,payload:{status:"draining"}})).statusCode).toBe(403);
  const buyerOrder=(await app.inject({url:"/v1/buyer/orders",headers:buyer})).json().items.find((o:any)=>o.listing.gpu.model==="RTX 4090");
  expect((await app.inject({url:`/v1/provider/orders/${buyerOrder.id}`,headers:other})).statusCode).toBe(403);
  const sellerOrders=await app.inject({url:"/v1/provider/orders",headers:seller});
  expect(sellerOrders.body).not.toContain('"command"');expect(sellerOrders.body).not.toContain('"buyerId"');
  await app.inject({method:"POST",url:"/v1/auth/register",payload:{identifier:"newbuyer@example.com",password,role:"buyer"}});
  const outsider=await login(app,"newbuyer@example.com");
  expect((await app.inject({url:`/v1/buyer/orders/${buyerOrder.id}`,headers:outsider})).statusCode).toBe(403);
  expect((await app.inject({url:"/v1/buyer/orders",headers:outsider})).json().items).toHaveLength(0);
 });
 it("买家创建、支付、提交任务、结束与再次租用，支付重复不重复分配",async()=>{
  const{app,service}=setup(),buyer=await login(app,"buyer@sourx.local"),seller=await login(app,"seller@sourx.local");
  const listing=(await app.inject({url:"/v1/catalog"})).json().items.find((l:any)=>l.gpu.model==="RTX 5090");
  const created=await app.inject({method:"POST",url:"/v1/orders",headers:buyer,payload:{listingId:listing.id,durationMinutes:60,totalAmountMinor:1}});
  expect(created.statusCode).toBe(201);const orderId=created.json().order.id;expect(created.json().order.totalAmountMinor).toBe(291);
  expect((await app.inject({method:"POST",url:`/v1/buyer/orders/${orderId}/pay`,headers:seller})).statusCode).toBe(403);
  for(let i=0;i<2;i++)expect((await app.inject({method:"POST",url:`/v1/buyer/orders/${orderId}/pay`,headers:buyer})).statusCode).toBe(200);
  expect([...service.store.leases.values()].filter((l)=>l.orderId===orderId)).toHaveLength(1);
  const order=(await app.inject({url:`/v1/buyer/orders/${orderId}`,headers:buyer})).json();
  const capability=(await app.inject({url:`/v1/orders/${orderId}/capability`,headers:buyer})).json();
  const payload={orderId,leaseId:order.lease.id,imageDigest:listing.imageDigests[0],command:["python","-c","print('private task')"],inputArtifactIds:[],maxRuntimeSeconds:60};
  const job=await app.inject({method:"POST",url:"/v1/gateway/jobs",headers:{authorization:`Bearer ${capability.token}`},payload});expect(job.statusCode).toBe(201);
  expect((await app.inject({url:"/v1/buyer/jobs",headers:buyer})).json().items).toHaveLength(1);
  expect((await app.inject({method:"POST",url:`/v1/orders/${orderId}/end`,headers:buyer})).json().cleanup.sandboxDestroyed).toBe(true);
  expect((await app.inject({url:`/v1/buyer/orders/${orderId}`,headers:buyer})).json().payment.status).toBe("settled");
  expect((await app.inject({method:"POST",url:"/v1/gateway/jobs",headers:{authorization:`Bearer ${capability.token}`},payload})).statusCode).toBe(400);
  expect((await app.inject({url:"/v1/buyer/jobs",headers:buyer})).json().items[0].status).toBe("cancelled");
  const again=await app.inject({method:"POST",url:"/v1/orders",headers:buyer,payload:{listingId:listing.id,durationMinutes:30}});expect(again.statusCode).toBe(201);
  const cancelled=await app.inject({method:"POST",url:`/v1/buyer/orders/${again.json().order.id}/cancel`,headers:buyer});expect(cancelled.json().status).toBe("cancelled");
 });
 it("卖家修改报价进入审核，运营上架，原订单价格保持快照",async()=>{
  const{app}=setup(),seller=await login(app,"seller@sourx.local"),operator=await login(app,"operator@sourx.local"),buyer=await login(app,"buyer@sourx.local");
  const item=(await app.inject({url:"/v1/provider/listings",headers:seller})).json().items.find((l:any)=>l.gpu.model==="RTX 4090");
  const oldOrder=(await app.inject({url:"/v1/buyer/orders",headers:buyer})).json().items.find((o:any)=>o.listingId===item.id);
  expect((await app.inject({method:"PATCH",url:`/v1/provider/listings/${item.id}`,headers:seller,payload:{pricePerHourMinor:999,minimumMinutes:60}})).json().status).toBe("pending_review");
  expect((await app.inject({method:"POST",url:`/v1/provider/listings/${item.id}/status`,headers:seller,payload:{status:"published"}})).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url:`/v1/listings/${item.id}/publish`,headers:seller})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:`/v1/listings/${item.id}/publish`,headers:operator})).statusCode).toBe(200);
  expect((await app.inject({url:`/v1/buyer/orders/${oldOrder.id}`,headers:buyer})).json().pricePerHourMinor).toBe(168);
  await app.inject({method:"POST",url:`/v1/provider/listings/${item.id}/status`,headers:seller,payload:{status:"paused"}});
  expect((await app.inject({url:`/v1/catalog/${item.id}`})).statusCode).toBe(404);
 });
 it("关闭本地模式后不提供样例身份与模拟支付入口",async()=>{
  process.env.DEMO_MODE="false";
  const {app,service}=setup();
  expect((await app.inject({url:"/v1/config"})).json()).toMatchObject({localMode:false,sampleAccounts:[]});
  expect(service.store.users.size).toBe(0);
  await app.inject({method:"POST",url:"/v1/auth/register",payload:{identifier:"buyer@example.com",password,role:"buyer"}});
  const buyer=await login(app,"buyer@example.com");
  expect((await app.inject({method:"POST",url:"/v1/buyer/orders/unknown/pay",headers:buyer})).json().error.code).toBe("PAYMENT_UNAVAILABLE");
 });
 it("重建应用恢复账号、会话、订单、任务和单次接入码",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"sourx-state-"));dirs.push(dir);const options={dataFile:join(dir,"state.json")};
  const app=createApp(new MarketplaceService(createStore()),options);apps.push(app);const buyer=await login(app,"buyer@sourx.local"),seller=await login(app,"seller@sourx.local");
  const orders=(await app.inject({url:"/v1/buyer/orders",headers:buyer})).json().items;
  const order=orders.find((o:any)=>o.status==="active");
  const token=(await app.inject({url:`/v1/orders/${order.id}/capability`,headers:buyer})).json().token;
  await app.inject({method:"POST",url:"/v1/gateway/jobs",headers:{authorization:`Bearer ${token}`},payload:{orderId:order.id,leaseId:order.lease.id,imageDigest:order.listing.imageDigests[0],command:["python"],inputArtifactIds:[],maxRuntimeSeconds:60}});
  const code=(await app.inject({method:"POST",url:"/v1/agent/enrollment-codes",headers:seller})).json().code;
  await app.close();apps.splice(apps.indexOf(app),1);
  const restored=createApp(new MarketplaceService(createStore()),options);apps.push(restored);
  expect((await restored.inject({url:"/v1/me",headers:buyer})).statusCode).toBe(200);
  expect((await restored.inject({url:"/v1/buyer/orders",headers:buyer})).json().items.map((o:any)=>o.id)).toEqual(orders.map((o:any)=>o.id));
  expect((await restored.inject({url:"/v1/buyer/jobs",headers:buyer})).json().items).toHaveLength(1);
  const payload={code,region:"cn-east-1",agentVersion:"test",certificateFingerprint:"test-fingerprint-12345",gpus:[{uuid:"GPU-restore",model:"RTX",vramMb:24576,cudaVersion:"12.4",benchmarkScore:100}]};
  expect((await restored.inject({method:"POST",url:"/v1/agent/enroll",payload})).statusCode).toBe(201);
  expect((await restored.inject({method:"POST",url:"/v1/agent/enroll",payload})).statusCode).toBe(400);
 });
});
