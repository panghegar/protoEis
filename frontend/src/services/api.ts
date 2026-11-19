export const API_BASE_URL=(import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV?'http://127.0.0.1:3001/api':'')).replace(/\/$/,'');
export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
export async function api<T>(path:string,token?:string,body?:unknown):Promise<T>{
  if(!API_BASE_URL) throw new Error('VITE_API_BASE_URL belum dikonfigurasi saat build.');
  const response=await fetch(API_BASE_URL+path,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>({error:'Respons API tidak valid.'}));
  if(!response.ok) throw new ApiError(data.error||'Permintaan gagal.',response.status);
  return data as T;
}
export type Config={epochs:number;batch_size:number;learning_rate:number;seed:number;device:'auto'|'cpu'|'cuda'};
export type Metric={epoch:number;train_loss:number;val_loss:number;val_accuracy:number};
export type Progress={epoch?:number;message?:string;history?:Metric[];elapsed_seconds?:number;best_val_accuracy?:number;test_accuracy?:number;device?:string;device_name?:string;gpu_peak_mb?:number;split?:{train:number;validation:number;test:number};examples?:{pixels:number[];actual:number;predicted:number}[]};
export type Job={id:string;workerId:string;status:string;config:Config;progress:Progress;cancelRequested:boolean;artifactPath:string|null;createdAt:string;startedAt:string|null;finishedAt:string|null};
export type Worker={id:string;name:string;disabled:boolean;online:boolean;lastSeen:string|null;capabilities:{bird_audio_version?:number;cuda?:boolean;gpu?:string;vram_gb?:number;torch?:string}};
export function saveJson(filename:string,data:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
