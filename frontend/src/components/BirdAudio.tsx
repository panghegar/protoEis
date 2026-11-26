import {useEffect,useRef,useState,type ChangeEvent} from 'react';
import {api,API_BASE_URL,ApiError,type Worker} from '../services/api';
import {hashPart,inspectAudio,type AudioInfo} from '../services/wav';
type BirdJob={id:string;workerId:string;status:string;cancelRequested:boolean;createdAt:string;finishedAt:string|null;audioExpiresAt:string|null;audioDeletedAt:string|null;audio:{name:string;size:number}&AudioInfo;simulation:boolean;config:{mode:string;minConfidence?:number;model?:{id:string;name:string}};progress:{percent?:number;message?:string;processedSegments?:number;totalSegments?:number}};
type Segment={ordinal:number;startSeconds:number;endSeconds:number;species:string;confidence:number;commonName?:string;status?:string;evidence?:string};
type Settings={storageReady:boolean;chunkBytes:number;maxBytes:number};
const labels:Record<string,string>={uploading:'Mengunggah',queued:'Menunggu',running:'Berjalan',completed:'Selesai',cancelled:'Dibatalkan',failed:'Gagal',interrupted:'Terputus'};
const time=(n:number)=>{const m=Math.floor(n/60),s=n%60;return String(m).padStart(2,'0')+':'+(s<10?'0':'')+s.toFixed(Number.isInteger(s)?0:2);};
const size=(n:number)=>(n/1024/1024).toFixed(1)+' MiB';
const message=(e:unknown)=>e instanceof Error?e.message:'Permintaan belum berhasil.';
export default function BirdAudio({workers,token}:{workers:Worker[];token:string}){
 const [settings,setSettings]=useState<Settings|null>(null),[jobs,setJobs]=useState<BirdJob[]>([]),[selected,setSelected]=useState('');
 const [file,setFile]=useState<File|null>(null),[wav,setWav]=useState<AudioInfo|null>(null),[preview,setPreview]=useState(''),[workerId,setWorkerId]=useState('');
 const [busy,setBusy]=useState(false),[reading,setReading]=useState(false),[error,setError]=useState(''),[upload,setUpload]=useState<{percent:number;message:string}|null>(null),[newFile,setNewFile]=useState(false);
 const [segments,setSegments]=useState<Segment[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(0),[exportPage,setExportPage]=useState(0);
 const input=useRef<HTMLInputElement>(null),controller=useRef<AbortController|null>(null),pending=useRef<string|null>(null),selection=useRef(0),cancelled=useRef(false);
 const active=workers.filter(w=>!w.disabled),device=active.find(w=>w.id===workerId)||active.find(w=>w.online&&w.capabilities.bird_audio_version===2&&!!w.capabilities.bird_model)||active.find(w=>w.capabilities.bird_audio_version===2&&!!w.capabilities.bird_model)||active[0];
 const job=newFile?undefined:jobs.find(j=>j.id===selected)||jobs[0];
 const step=job?.status==='completed'?4:upload||job?3:file?2:1;
 async function refresh(){const items=await api<BirdJob[]>('/bird-jobs',token);setJobs(items);}
 useEffect(()=>{let stopped=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const [cfg,items]=await Promise.all([api<Settings>('/bird/config',token),api<BirdJob[]>('/bird-jobs',token)]);if(!stopped){setSettings(cfg);setJobs(items);}}catch(e){if(!stopped)setError(message(e));}finally{if(!stopped)timer=setTimeout(poll,4000);}};void poll();return()=>{stopped=true;clearTimeout(timer);controller.current?.abort();};},[token]);
 useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return()=>URL.revokeObjectURL(url);},[file]);
 useEffect(()=>{setPage(0);setExportPage(0);setSegments([]);setTotal(0);},[job?.id]);
 useEffect(()=>{let stopped=false;if(job?.status!=='completed')return;void api<{items:Segment[];total:number}>('/bird-jobs/'+job.id+'/segments?offset='+page*100,token).then(r=>{if(!stopped){setSegments(r.items);setTotal(r.total);}}).catch(e=>{if(!stopped)setError(message(e));});return()=>{stopped=true;};},[job?.id,job?.status,page,token]);
 async function choose(candidate?:File){
  if(!candidate||busy)return;const version=++selection.current;setReading(true);setError('');
  try{if(candidate.size>(settings?.maxBytes||700*1024*1024))throw new Error('Batas awal rekaman adalah 700 MiB per file.');const info=await inspectAudio(candidate);if(version!==selection.current)return;setFile(candidate);setWav(info);setNewFile(true);setSelected('');pending.current=null;setUpload(null);}catch(e){if(version===selection.current){setFile(null);setWav(null);setError(message(e));}}finally{if(version===selection.current)setReading(false);}
 }
 async function start(){
  if(!file||!wav||!device||!settings||busy)return;
  if(!settings.storageReady){setError('Pengelola perlu mengaktifkan Supabase Storage audio pada backend terlebih dahulu.');return;}
  if(device.capabilities.bird_audio_version!==2||!device.capabilities.bird_model){setError('Impor ZIP model Syafiq, klik Siapkan model burung pada launcher, lalu jalankan worker kembali.');return;}
  setBusy(true);setError('');cancelled.current=false;controller.current=new AbortController();
  let current=pending.current;
  try{
   const count=Math.ceil(file.size/settings.chunkBytes),hashes:string[]=[];
   for(let i=0;i<count;i++){if(cancelled.current)throw new Error('Unggahan dibatalkan.');setUpload({percent:0,message:'Memeriksa checksum bagian '+(i+1)+'/'+count+'…'});hashes.push(await hashPart(file.slice(i*settings.chunkBytes,(i+1)*settings.chunkBytes)));}
   if(cancelled.current)throw new Error('Unggahan dibatalkan.');
   if(!current){const created=await api<BirdJob>('/bird-jobs',token,{workerId:device.id,mode:'inference',audio:{name:file.name,size:file.size,...wav,hashes}});current=created.id;pending.current=current;setSelected(current);setJobs(items=>[created,...items]);}
   if(cancelled.current){await api('/jobs/'+current+'/cancel',token,{});throw new Error('Unggahan dibatalkan.');}
   setNewFile(false);
   for(let i=0;i<count;i++){
    if(cancelled.current)throw new Error('Unggahan dibatalkan.');
    setUpload({percent:i/count*100,message:'Mengunggah bagian '+(i+1)+'/'+count+' langsung ke Storage privat…'});
    const part=file.slice(i*settings.chunkBytes,(i+1)*settings.chunkBytes);
    let sent=false;
    for(let attempt=0;attempt<3;attempt++){
     if(cancelled.current)throw new Error('Unggahan dibatalkan.');
     try{
      const ticket=await api<{url?:string;uploaded?:boolean}>('/bird-jobs/'+current+'/upload-ticket',token,{index:i});
      if(ticket.uploaded){sent=true;break;}
      if(!ticket.url)throw new Error('Tautan unggah tidak tersedia.');
      const result=await fetch(ticket.url,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:part,signal:controller.current.signal});
      if(!result.ok)throw new Error('Unggahan bagian '+(i+1)+' ditolak Storage (HTTP '+result.status+').');
      sent=true;break;
     }catch(e){if(cancelled.current||attempt===2)throw e;await new Promise(resolve=>setTimeout(resolve,750*(attempt+1)));}
    }
    if(!sent)throw new Error('Bagian audio belum selesai diunggah.');
   }
   if(cancelled.current)throw new Error('Unggahan dibatalkan.');
   setUpload({percent:100,message:'Memeriksa kelengkapan unggahan…'});
   const queued=await api<BirdJob>('/bird-jobs/'+current+'/finalize',token,{});setJobs(items=>items.map(j=>j.id===queued.id?queued:j));pending.current=null;setUpload(null);setFile(null);setWav(null);
  }catch(e){if(!cancelled.current)setError(message(e)+' Anda dapat mencoba unggah lagi dengan file yang sama, atau membatalkan proses.');setUpload(null);}
  finally{setBusy(false);await refresh().catch(()=>{});}
 }
 async function cancel(){cancelled.current=true;controller.current?.abort();const ident=pending.current||job?.id;if(!ident){setUpload(null);return;}try{await api('/jobs/'+ident+'/cancel',token,{});pending.current=null;setUpload(null);await refresh();}catch(e){setError(message(e));}}
 async function download(){if(!job)return;setError('');try{const response=await fetch(API_BASE_URL+'/bird-jobs/'+job.id+'/xlsx?offset='+exportPage*10000,{headers:{Authorization:'Bearer '+token}});if(!response.ok){const data=await response.json().catch(()=>({}));throw new ApiError(data.error||'XLSX belum dapat diunduh.',response.status);}const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='hasil-'+(job.simulation?'SIMULASI-':'identifikasi-')+job.id.slice(0,8)+(total>10000?'-bagian-'+(exportPage+1):'')+'.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){setError(message(e));}}
 const changeFile=()=>{setNewFile(true);setSelected('');setFile(null);setWav(null);setUpload(null);pending.current=null;if(input.current)input.current.value='';};
 const processing=job&&['uploading','queued','running'].includes(job.status);
 return <section className="bird-page"><div className="intro"><div><span className="eyebrow">MODUL BURUNG / AUDIO LOKAL</span><h1>Identifikasi suara burung.</h1><p>Unggah satu rekaman WAV atau MP3, proses melalui worker laptop, lalu ambil hasilnya.</p></div><span className="simulation-badge">MODEL SUMATRA · SEMENTARA</span></div>
 <ol className="bird-steps" aria-label="Tahapan identifikasi">{['Unggah audio','Mulai identifikasi','Tunggu proses','Ambil hasil'].map((label,i)=><li key={label} className={step===i+1?'current':step>i+1?'done':''} aria-current={step===i+1?'step':undefined}><b>{i+1}</b><span>{label}</span></li>)}</ol>
 <div className="notice"><b>MODEL SEMENTARA</b><span>Identifikasi memakai BirdNET global dan classifier Sumatra dari Syafiq. Ambang confidence 25%. “Tidak ada deteksi” berarti tidak ada skor yang melewati ambang, sehingga tidak membuktikan burung tidak ada. Model ini belum final.</span></div>
 {error&&<div className="alert" role="alert">{error}<button aria-label="Tutup pesan identifikasi" onClick={()=>setError('')}>×</button></div>}
 {settings&&!settings.storageReady&&<div className="alert" role="status">Storage audio belum aktif. Pengelola perlu mengatur bucket privat dan environment Supabase pada backend. Pemilihan audio dapat dicoba; unggahan belum tersedia.</div>}
 <input ref={input} className="file-input" type="file" accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg" aria-label="Pilih rekaman WAV atau MP3" disabled={busy||reading} onChange={(e:ChangeEvent<HTMLInputElement>)=>void choose(e.target.files?.[0])}/>
 {!job&&!file&&<section className="card"><button className="audio-dropzone" disabled={busy||reading} onClick={()=>input.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files.length!==1){setError('Pilih satu file WAV atau MP3 per proses.');return;}void choose(e.dataTransfer.files[0]);}}><span aria-hidden="true">♫</span><strong>{reading?'Memeriksa rekaman…':'Pilih rekaman audio'}</strong><small>atau tarik satu file WAV atau MP3 ke sini</small></button><p className="hint">WAV PCM atau MP3 mono/stereo, maksimal 700 MiB dan 2 jam untuk prototipe. Unggahan dibagi otomatis menjadi bagian 20 MiB; tidak mengubah audio.</p></section>}
 {file&&wav&&!upload&&(!job||job.status==='uploading')&&<section className="card bird-ready"><div className="bird-file"><strong>{file.name}</strong><span>{time((wav.wav||wav.mp3)!.duration)} · {size(file.size)}</span></div><p className="hint">{wav.wav?wav.wav.sampleRate.toLocaleString('id-ID')+' Hz · '+wav.wav.bits+'-bit · '+(wav.wav.channels===1?'Mono':'Stereo'):'MP3 · durasi akan diverifikasi decoder worker'} · {Math.ceil(file.size/(settings?.chunkBytes||20971520))} bagian transfer</p>{preview&&<audio controls preload="metadata" src={preview}>Browser tidak mendukung pemutar audio.</audio>}<label>Worker tujuan<select disabled={busy||!!pending.current} value={device?.id||''} onChange={e=>setWorkerId(e.target.value)}><option value="" disabled>Pilih worker</option>{active.map(w=><option key={w.id} value={w.id}>{w.name} · {w.online?'online':'offline'}{w.capabilities.bird_audio_version!==2||!w.capabilities.bird_model?' · model belum siap':' · model siap'}</option>)}</select></label>{device&&!device.capabilities.bird_model&&<p className="hint">Pada launcher laptop tujuan, impor ZIP model Syafiq, klik Siapkan model burung, lalu jalankan worker kembali.</p>}{device&&!device.online&&<p className="hint">Worker offline. Unggahan dapat disiapkan, lalu proses menunggu worker yang dipilih kembali online.</p>}<div className="actions"><button className="primary" disabled={busy||!device||!settings?.storageReady||reading||device.capabilities.bird_audio_version!==2||!device.capabilities.bird_model} onClick={()=>void start()}>{pending.current?'Coba unggah lagi':'Mulai identifikasi'}</button><button className="secondary" disabled={busy||!!pending.current} onClick={()=>input.current?.click()}>Ganti file</button></div></section>}
 {(upload||job)&&<section className="card bird-monitor"><div className="bird-file"><strong>{job?.audio.name||file?.name}</strong><span className={'tag '+(job?.status||'running')}>{upload?'Mengunggah':labels[job?.status||'']||'Menyiapkan'}</span></div><p className="status-message" aria-live="polite">{upload?.message||(job?.cancelRequested&&job.status==='running'?'Menunggu worker menghentikan proses…':job?.status==='queued'?'Menunggu worker '+(workers.find(w=>w.id===job.workerId)?.name||'terpilih')+' online dan tersedia.':job?.progress.message)}</p>
 <progress max={100} value={upload?.percent??job?.progress.percent??0} aria-label={upload?'Progres unggahan audio':'Progres identifikasi'}/><div className="progress-label"><span>{upload?'Mengunggah audio':job?.status==='completed'?'Identifikasi selesai':'Memproses rekaman'} · {Math.round(upload?.percent??job?.progress.percent??0)}%</span><span>{job?.progress.processedSegments||0} / {job?.progress.totalSegments||'—'} segmen</span></div>
 {processing||upload?<div className="actions"><button className="secondary" disabled={!!job?.cancelRequested} onClick={()=>void cancel()}>Batalkan</button></div>:null}
 {job?.status==='completed'&&<><p className="hint">{job.simulation?'SIMULASI: label dan confidence adalah data contoh.':(job.config.model?.name||'Model sementara')+' · Versi '+job.config.model?.id.slice(0,12)+' · Confidence adalah skor model, bukan persentase akurasi. Satu segmen dapat memuat beberapa spesies.'}</p><div className="bird-table-wrap"><table><thead><tr><th>Segmen</th><th>{job.simulation?"Spesies contoh":"Hasil identifikasi"}</th><th>Confidence</th><th>Sumber</th></tr></thead><tbody>{segments.map(s=><tr key={s.ordinal}><td>{time(s.startSeconds)} – {time(s.endSeconds)}</td><td>{s.species}{s.commonName&&<small style={{display:"block"}}>{s.commonName}</small>}</td><td>{s.status==='no_detection'?'—':Math.round(s.confidence*100)+'%'}</td><td>{job.simulation?'SIMULASI':s.evidence}</td></tr>)}</tbody></table></div><div className="bird-pagination"><button className="secondary" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Sebelumnya</button><small>{total} baris hasil · Halaman {page+1} / {Math.max(1,Math.ceil(total/100))}</small><button className="secondary" disabled={(page+1)*100>=total} onClick={()=>setPage(p=>p+1)}>Berikutnya</button></div>{total>10000&&<label>Bagian hasil Excel<select value={exportPage} onChange={e=>setExportPage(Number(e.target.value))}>{Array.from({length:Math.ceil(total/10000)},(_,i)=><option key={i} value={i}>Bagian {i+1} · baris {i*10000+1}–{Math.min(total,(i+1)*10000)}</option>)}</select><small>Setiap file memuat maksimal 10.000 baris. Unduh seluruh bagian untuk memperoleh semua hasil.</small></label>}<div className="actions"><button className="primary" onClick={()=>void download()}>↓ Unduh Excel (.xlsx){job.simulation?' · simulasi':''}</button><button className="secondary" onClick={changeFile}>Identifikasi audio lain</button></div></>}
 {job&&!['completed','queued','running','uploading'].includes(job.status)&&<button className="secondary" onClick={changeFile}>Pilih audio untuk proses baru</button>}
 {job&&<p className="hint">{job.audioDeletedAt?'Audio cloud telah dibersihkan. Hasil dan XLSX tetap tersedia.':job.audioExpiresAt?'Audio cloud kedaluwarsa '+new Date(job.audioExpiresAt).toLocaleString('id-ID')+'. Penghapusan fisik mengikuti jadwal pembersihan.':'Audio hanya disimpan sementara.'} File asli di laptop tidak dihapus.</p>}
 </section>}
 <section className="card bird-history"><div className="section-heading"><span>↺</span><h2>Riwayat identifikasi</h2></div><p className="hint">50 proses terbaru. Hasil tetap tersimpan setelah audio kedaluwarsa.</p><div className="history">{jobs.map(item=><button disabled={busy} key={item.id} className={!newFile&&job?.id===item.id?'selected':''} onClick={()=>{setNewFile(false);setSelected(item.id);setError('');}}><strong>{item.audio.name}</strong><small>{labels[item.status]} · {item.simulation?'SIMULASI':'MODEL SEMENTARA'} · {new Date(item.createdAt).toLocaleString('id-ID')}</small></button>)}{!jobs.length&&<p className="muted">Belum ada identifikasi audio.</p>}</div>{job&&<button className="secondary" disabled={busy} onClick={changeFile}>＋ Rekaman baru</button>}</section>
 </section>;
}
