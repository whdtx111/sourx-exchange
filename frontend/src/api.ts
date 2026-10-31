import type {Session} from "./types";
const storageKey = "sourx.session.v2";
export class ApiError extends Error { constructor(message:string,public status:number) {super(message);} }
export function readSession(): Session | null { try {return JSON.parse(localStorage.getItem(storageKey) ?? "null") as Session|null;} catch {return null;} }
export function saveSession(session:Session|null) { if (session) localStorage.setItem(storageKey,JSON.stringify(session)); else localStorage.removeItem(storageKey); }
const refreshes = new Map<string,Promise<Session>>();
export async function api<T>(path:string, options:RequestInit = {}, token?:string, retried=false):Promise<T> {
  const session = readSession();
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type","application/json");
  const bearer = token ?? session?.accessToken;
  if (bearer) headers.set("authorization",`Bearer ${bearer}`);
  const response = await fetch(path,{...options,headers});
  if (response.status === 401 && !retried && !token && session && !path.startsWith("/v1/auth/")) {
    const current=readSession();
    if (current?.accessToken !== session.accessToken) {
      if (current?.user.id === session.user.id) return api<T>(path,options,undefined,true);
      throw new ApiError("请求所属会话已结束",401);
    }
    try {
      let pending=refreshes.get(session.refreshToken);
      if (!pending) {
        pending=api<Session>("/v1/auth/refresh",{method:"POST",body:JSON.stringify({refreshToken:session.refreshToken})},undefined,true).finally(()=>refreshes.delete(session.refreshToken));
        refreshes.set(session.refreshToken,pending);
      }
      const next = await pending;
      const active=readSession()?.accessToken;
      if (active !== session.accessToken && active !== next.accessToken) throw new ApiError("请求所属会话已结束",401);
      saveSession(next);
      return api<T>(path,options,undefined,true);
    } catch {
      if (readSession()?.accessToken === session.accessToken) {
        saveSession(null); window.dispatchEvent(new Event("sourx:unauthorized"));
      }
      throw new ApiError("登录已过期，请重新登录",401);
    }
  }
  if (response.status === 204) return null as T;
  const body = await response.json();
  if (!response.ok) throw new ApiError(body?.error?.message ?? `请求失败 (${response.status})`,response.status);
  return body as T;
}
export const post = <T>(path:string,body?:unknown,token?:string) => api<T>(path,{method:"POST",...(body === undefined ? {} : {body:JSON.stringify(body)})},token);
