import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {api,readSession,saveSession} from "../frontend/src/api";
import type {Session} from "../frontend/src/types";

const session=(name:string):Session=>({accessToken:`access-${name}`,refreshToken:`refresh-${name}`,accessExpiresAt:0,user:{id:name==="seller"?"seller":"buyer",role:name==="seller"?"provider":"buyer"}});
const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>((done)=>{resolve=done;});return {promise,resolve};};
describe("浏览器会话并发与账号切换",()=>{
 let dispatch:ReturnType<typeof vi.fn>;
 beforeEach(()=>{
  const values=new Map<string,string>();
  vi.stubGlobal("localStorage",{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
  dispatch=vi.fn();vi.stubGlobal("window",{dispatchEvent:dispatch});
 });
 afterEach(()=>vi.unstubAllGlobals());
 it("并发过期请求仅刷新一次，均使用轮换后的会话重试",async()=>{
  saveSession(session("old"));const next=session("new"),gate=deferred<Response>();let refreshCalls=0;
  vi.stubGlobal("fetch",vi.fn(async(path:string,options:RequestInit)=>{
   if(path==="/v1/auth/refresh"){refreshCalls++;return gate.promise;}
   return new Headers(options.headers).get("authorization")==="Bearer access-new"?response(200,{ok:true}):response(401,{});
  }));
  const a=api("/v1/me"),b=api("/v1/buyer/orders");
  await vi.waitFor(()=>expect(refreshCalls).toBe(1));gate.resolve(response(200,next));
  expect(await Promise.all([a,b])).toEqual([{ok:true},{ok:true}]);expect(readSession()).toEqual(next);expect(dispatch).not.toHaveBeenCalled();
 });
 it("另一请求已经刷新成功时，延迟返回的 401 使用当前会话重试",async()=>{
  saveSession(session("old"));const gate=deferred<Response>();
  vi.stubGlobal("fetch",vi.fn(async(path:string,options:RequestInit)=>{
   if(path==="/v1/auth/refresh")return response(200,session("new"));
   if(new Headers(options.headers).get("authorization")==="Bearer access-new")return response(200,{ok:true});
   return path==="/v1/slow"?gate.promise:response(401,{});
  }));
  const slow=api("/v1/slow");expect(await api("/v1/me")).toEqual({ok:true});gate.resolve(response(401,{}));
  expect(await slow).toEqual({ok:true});expect(dispatch).not.toHaveBeenCalled();
 });
 it("退出后到达的旧请求不刷新会话或产生失效通知",async()=>{
  saveSession(session("old"));const gate=deferred<Response>(),fetcher=vi.fn(()=>gate.promise);vi.stubGlobal("fetch",fetcher);
  const pending=api("/v1/me"),failure=expect(pending).rejects.toThrow("会话已结束");saveSession(null);gate.resolve(response(401,{}));await failure;
  expect(fetcher).toHaveBeenCalledTimes(1);expect(readSession()).toBeNull();expect(dispatch).not.toHaveBeenCalled();
 });
 it.each([200,400])("切换账号期间旧会话刷新返回 %i 不覆盖或清除新账号",async(status)=>{
  saveSession(session("old"));const gate=deferred<Response>();let refreshing=false;
  vi.stubGlobal("fetch",vi.fn((path:string)=>{if(path==="/v1/auth/refresh"){refreshing=true;return gate.promise;}return Promise.resolve(response(401,{}));}));
  const pending=api("/v1/me"),failure=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(refreshing).toBe(true));
  const switched=session("seller");saveSession(switched);gate.resolve(response(status,session("rotated-old")));await failure;
  expect(readSession()).toEqual(switched);expect(dispatch).not.toHaveBeenCalled();
 });
});
