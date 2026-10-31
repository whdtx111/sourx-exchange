import {useEffect,useRef,type ReactNode} from "react";
import {useApp} from "../context";
import {Link} from "../router";
export function Icon({name,size=20}:{name:string;size?:number}) {
  const paths:Record<string,ReactNode>={
    grid:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    chip:<><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6" rx=".5"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3"/></>,
    orders:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></>,
    workspace:<><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m7 8 3 3-3 3m6 0h4M8 21h8m-4-3v3"/></>,
    wallet:<><path d="M20 7V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h15v12H6a3 3 0 0 1-3-3V6"/><path d="M21 12h-6v5h6m-4-2.5h1"/></>,
    server:<><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.1M7 17.5h.1M11 6.5h6m-6 11h6"/></>,
    shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
    arrow:<path d="M5 12h14m-5-5 5 5-5 5"/>,
    search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,
    chevron:<path d="m9 5 7 7-7 7"/>,
    refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></>,
    logout:<><path d="M9 3H4v18h5m5-14 5 5-5 5M8 12h11"/></>,
    help:<><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    location:<><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,
    check:<path d="m5 12 4 4 10-10"/>,
    user:<><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
    menu:<path d="M4 6h16M4 12h16M4 18h16"/>,
    back:<path d="M19 12H5m5-5-5 5 5 5"/>,
    bolt:<path d="m13 2-9 12h7l-1 8 10-12h-7l0-8Z"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.chip}</svg>;
}
export const money=(value:number)=>`¥${(value/100).toFixed(2)}`;
export const date=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}):"—";
export const region=(value:string)=>({"cn-east-1":"华东 · 上海","cn-north-1":"华北 · 北京","cn-south-1":"华南 · 广州"}[value]??value);
export const short=(id:string)=>id.slice(-8).toUpperCase();
export const roleLabel={buyer:"买家工作台",provider:"卖家中心",operator:"平台运营"};
export function Badge({status,label}:{status:string;label?:string}) {
 const names:Record<string,string>={active:"使用中",ready:"已就绪",running:"运行中",online:"在线",published:"已上架",available:"可租用",busy:"租用中",completed:"已完成",settled:"已结算",payment_pending:"待支付",pending_review:"待审核",paid:"已托管",allocating:"准备中",paused:"已下架",draining:"暂停接单",offline:"离线",cancelled:"已取消",failed:"失败",queued:"排队中",succeeded:"已完成",ending:"清理中",ended:"已结束",authorized:"已托管",disputed:"争议中",refunded:"已退款",created:"待授权",voided:"已撤销"};
 return <span className={`badge badge-${status}`}><i/>{label??names[status]??status}</span>;
}
export function PageHeading({title,subtitle,action}:{title:string;subtitle:string;action?:ReactNode}) {return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;}
export function Stat({label,value,note,icon}:{label:string;value:ReactNode;note:string;icon:string}){return <div className="stat"><div><span>{label}</span><Icon name={icon}/></div><strong>{value}</strong><small>{note}</small></div>;}
export function Empty({title="暂无记录",text,action}:{title?:string;text:string;action?:ReactNode}){return <div className="empty"><div className="empty-icon"><Icon name="orders" size={30}/></div><h3>{title}</h3><p>{text}</p>{action}</div>;}
export function State({loading,error,children}:{loading:boolean;error:string|null;children:ReactNode}){const{invalidate}=useApp();return error?<div className="error-box" role="alert"><strong>内容未能加载</strong><p>{error}</p><button className="button secondary" onClick={invalidate}>重新加载</button></div>:loading?<div className="loading" role="status"><span className="spinner"/>正在加载…</div>:<>{children}</>;}
export function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
 const dialog=useRef<HTMLElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{const old=document.body.style.overflow;document.body.style.overflow="hidden";const previous=document.activeElement as HTMLElement|null;
 const focusable=()=>Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[]);
 focusable()[0]?.focus();
 const close=(e:KeyboardEvent)=>{if(e.key==="Escape")closeRef.current();if(e.key==="Tab"){const items=focusable();const first=items[0],last=items[items.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};window.addEventListener("keydown",close);return()=>{document.body.style.overflow=old;window.removeEventListener("keydown",close);previous?.focus();};},[]);
 return <div className="modal-backdrop" onClick={(e)=>{if(e.target===e.currentTarget)onClose();}}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭窗口" onClick={onClose}>×</button></header>{children}</section></div>;
}
export function Panel({title,action,children,className=""}:{title?:string;action?:ReactNode;children:ReactNode;className?:string}){return <section className={`panel ${className}`}>{title&&<header className="panel-header"><h2>{title}</h2>{action}</header>}{children}</section>;}
export function Steps({current}:{current:number}){return <div className="steps">{["确认配置","平台托管","使用算力","完成结算"].map((name,i)=><div className={i<=current?"done":""} key={name}><span>{i<current?<Icon name="check" size={13}/>:i+1}</span>{name}</div>)}</div>;}
export function OrderLink({id,side="buyer"}:{id:string;side?:string}){return <Link to={`/${side}/orders/${id}`} className="text-link">查看详情 <Icon name="chevron" size={13}/></Link>;}
export function GpuArt({model,compact=false}:{model:string;compact?:boolean}) {return <div className={`gpu-art ${compact?"compact":""}`}><div className="gpu-board"><div className="gpu-fan"><i/><i/><i/><i/><i/><i/></div><span>NVIDIA</span><div className="gpu-fan second"><i/><i/><i/><i/><i/><i/></div></div><span className="gpu-model-mark">{model.replace("PCIe","")}</span></div>;}
