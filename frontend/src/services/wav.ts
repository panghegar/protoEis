export type WavInfo={channels:number;sampleRate:number;bits:8|16|24|32;frames:number;duration:number};
const text=(v:DataView,start:number,length:number)=>Array.from({length},(_,i)=>String.fromCharCode(v.getUint8(start+i))).join('');
// Scan RIFF headers with bounded slices: never decode an hour-long file in memory.
export async function inspectWav(file:File):Promise<WavInfo>{
 if(!/\.wav$/i.test(file.name)||file.size<44)throw new Error('Pilih file WAV PCM yang valid.');
 const first=new DataView(await file.slice(0,12).arrayBuffer());
 if(text(first,0,4)!=='RIFF'||text(first,8,4)!=='WAVE')throw new Error('Format awal mendukung RIFF/WAVE PCM; RF64 dan audio terkompresi belum didukung.');
 if(first.getUint32(4,true)+8!==file.size)throw new Error('Ukuran RIFF berbeda dari file WAV; periksa apakah rekaman terpotong.');
 let offset=12,format:Omit<WavInfo,'frames'|'duration'>|undefined,dataBytes=0,align=0,chunks=0;
 while(offset+8<=file.size&&chunks++<4096){
  const h=new DataView(await file.slice(offset,offset+8).arrayBuffer()),kind=text(h,0,4),length=h.getUint32(4,true);
  if(offset+8+length>file.size)throw new Error('Isi WAV terpotong.');
  if(kind==='fmt '){
   if(length<16||length>65536)throw new Error('Header format WAV tidak valid.');
   const v=new DataView(await file.slice(offset+8,offset+8+length).arrayBuffer());
   let encoding=v.getUint16(0,true);
   if(encoding===65534&&length>=40){if(v.getUint16(18,true)!==v.getUint16(14,true)||text(v,26,14)!=='\0\0\0\0\x10\0\x80\0\0\xaa\0\x38\x9b\x71')throw new Error('WAV extensible ini belum didukung.');encoding=v.getUint16(24,true);}
   const channels=v.getUint16(2,true),sampleRate=v.getUint32(4,true),bits=v.getUint16(14,true);align=v.getUint16(12,true);
   if(encoding!==1||![1,2].includes(channels)||![8,16,24,32].includes(bits)||sampleRate<8000||sampleRate>192000||align!==channels*bits/8||v.getUint32(8,true)!==sampleRate*align)throw new Error('Demo mendukung WAV PCM 8/16/24/32-bit, mono/stereo, 8–192 kHz.');
   format={channels,sampleRate,bits:bits as WavInfo['bits']};
  }
  if(kind==='data'){dataBytes=length;if(format)break;}
  offset+=8+length+(length%2);
 }
 if(!format||!dataBytes||dataBytes%align)throw new Error('Header atau data WAV tidak lengkap.');
 const frames=dataBytes/align,duration=frames/format.sampleRate;
 if(!Number.isFinite(duration)||duration<=0||duration>7200)throw new Error('Durasi demo maksimal 2 jam.');
 return {...format,frames,duration};
}
export async function hashPart(blob:Blob){const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}
