import {createContext,useCallback,useContext,useEffect,useState,type ReactNode} from "react";
import {api,post,readSession,saveSession} from "./api";
import type {Config,Session,User} from "./types";
const Context = createContext<{
  user:User|null;ready:boolean;config:Config|null;revision:number;invalidate:()=>void;
  login:(identifier:string,password:string)=>Promise<User>;logout:()=>Promise<void>;
  notify:(message:string,error?:boolean)=>void;
}>(null!);
export function AppProvider({children}:{children:ReactNode}) {
  const [user,setUser]=useState<User|null>(null), [ready,setReady]=useState(false),[config,setConfig]=useState<Config|null>(null),[revision,setRevision]=useState(0);
  const [toast,setToast]=useState<{message:string;error:boolean}|null>(null);
  const notify=useCallback((message:string,error=false)=>setToast({message,error}),[]);
  useEffect(()=>{if (!toast) return; const timer=setTimeout(()=>setToast(null),4500);return ()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    void api<Config>("/v1/config").then(setConfig).catch(()=>notify("无法连接平台，请检查后端服务",true));
    if(readSession()) void api<User>("/v1/me").then(setUser).catch(()=>saveSession(null)).finally(()=>setReady(true));
    else setReady(true);
    const expired=()=>{setUser(null);notify("会话已失效，请重新登录",true);};
    window.addEventListener("sourx:unauthorized",expired);return ()=>window.removeEventListener("sourx:unauthorized",expired);
  },[notify]);
  const login=async(identifier:string,password:string)=>{
    const tokens=await post<Session>("/v1/auth/login",{identifier,password});saveSession(tokens);
    const current=await api<User>("/v1/me");setUser(current);setToast(null);setRevision((r)=>r+1);return current;
  };
  const logout=async()=>{try{await post("/v1/auth/logout");}finally{saveSession(null);setUser(null);setToast(null);setRevision((r)=>r+1);}};
  return <Context.Provider value={{user,ready,config,revision,invalidate:()=>setRevision((r)=>r+1),login,logout,notify}}>{children}{toast&&<div className={`toast ${toast.error?"error":""}`} role="status">{toast.error?"!":"✓"}<span>{toast.message}</span><button aria-label="关闭通知" onClick={()=>setToast(null)}>×</button></div>}</Context.Provider>;
}
export const useApp=()=>useContext(Context);
export function useResource<T>(path:string|null) {
  const {revision,user}=useApp();
  const [state,setState]=useState<{data:T|null;error:string|null;loading:boolean}>({data:null,error:null,loading:true});
  useEffect(()=>{
    let live=true;
    setState({data:null,error:null,loading:!!path});
    if(path) void api<T>(path).then((data)=>{if(live)setState({data,error:null,loading:false});}).catch((e:Error)=>{if(live)setState({data:null,error:e.message,loading:false});});
    return ()=>{live=false;};
  },[path,revision,user?.id]);
  return state;
}
