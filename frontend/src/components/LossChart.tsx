import type {Metric} from '../services/api';
export default function LossChart({history}:{history:Metric[]}){
 if(!history.length)return <div className="chart empty">Kurva muncul setelah epoch pertama selesai.</div>;
 const w=680,h=235,p=35,max=Math.max(.1,...history.flatMap(r=>[r.train_loss,r.val_loss]))*1.1;
 const x=(i:number)=>p+i/Math.max(1,history.length-1)*(w-p*2);
 const y=(v:number)=>h-p-v/max*(h-p*2);
 return <div className="chart"><svg viewBox={'0 0 '+w+' '+h} role="img" aria-label="Grafik train loss dan validation loss">
 {[0,1,2,3,4].map(i=><g key={i}><line x1={p} x2={w-p} y1={y(max*i/4)} y2={y(max*i/4)} stroke="#e3e9e1"/><text x={3} y={y(max*i/4)+4}>{(max*i/4).toFixed(2)}</text></g>)}
 {(['train_loss','val_loss'] as const).map((key,i)=><polyline key={key} fill="none" stroke={i?'#d88b49':'#427b25'} strokeWidth={3} points={history.map((r,n)=>x(n)+','+y(r[key])).join(' ')}/>)}
 <text x={p} y={h-8}>Epoch 1</text><text x={w-p} y={h-8} textAnchor="end">Epoch {history.length}</text></svg></div>;
}
