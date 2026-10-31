import {afterEach,describe,expect,it} from "vitest";
import {createApp} from "../src/api/app.js";
import {MarketplaceService} from "../src/domain/service.js";
import {createStore} from "../src/domain/store.js";

describe("本地交易平台",()=>{
 const apps:ReturnType<typeof createApp>[]=[];
 const previous=process.env.DEMO_MODE;
 afterEach(async()=>{await Promise.all(apps.splice(0).map((a)=>a.close()));if(previous===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=previous;});
 it("构建页面可深链接，公开接口不再泄露全平台身份",async()=>{
  process.env.DEMO_MODE="true";const app=createApp(new MarketplaceService(createStore()));apps.push(app);
  const page=await app.inject({url:"/buyer/market"});expect(page.statusCode).toBe(200);expect(page.body).toContain("SourX Exchange");
  const assets=[...page.body.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m)=>m[1]!);expect(assets).toHaveLength(2);
  for(const asset of assets)expect((await app.inject({url:asset})).statusCode).toBe(200);
  expect((await app.inject({url:"/assets/missing.css"})).statusCode).toBe(404);
  expect((await app.inject({url:"/v1/demo/overview"})).statusCode).toBe(404);
  expect((await app.inject({url:"/v1/provider/nodes"})).statusCode).toBe(401);
  const catalog=await app.inject({url:"/v1/catalog"});expect(catalog.json().items).toHaveLength(6);
  for(const forbidden of ["certificate","Fingerprint","GPU-SOURX","sandboxId","tokenVersion","password","buyerId"])expect(catalog.body).not.toContain(forbidden);
 });
});
