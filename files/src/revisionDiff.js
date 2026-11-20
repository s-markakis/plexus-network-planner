// Revision diff: what changed between two snapshots of the plan's floors.
// Pure (moved out of app.js).

/**
 * Human-readable changes between two floor lists (revision snapshots or the
 * live plan): devices/zones/walls added, removed, moved, and the identity,
 * wiring and rollout fields that changed.
 * @param {any[]} a  before
 * @param {any[]} b  after
 * @returns {string[]}
 */
export function diffRevisions(a,b){
  // Walk floor by floor and report adds/removes/moves of APs+CAMs+SWs+DZs+WALLS.
  const out=[];
  const fLen=Math.max(a.length,b.length);
  for(let i=0;i<fLen;i++){
    const fa=a[i],fb=b[i];
    if(!fa){out.push(`+ Floor "${fb.name||i}" added`);continue;}
    if(!fb){out.push(`- Floor "${fa.name||i}" removed`);continue;}
    for(const kind of ['APS','CAMS','SWS','DZS','WALLS']){
      const la=fa[kind]||[],lb=fb[kind]||[];
      const ids=new Set([...la.map(x=>x.id),...lb.map(x=>x.id)]);
      for(const id of ids){
        const ia=la.find(x=>x.id===id), ib=lb.find(x=>x.id===id);
        if(ia && !ib)out.push(`- [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id} removed`);
        else if(!ia && ib)out.push(`+ [${fb.name||i}] ${kind.slice(0,-1)} ${ib.name||id} added`);
        else if(ia && ib){
          // Walls carry endpoint coords (fx1/fy1/fx2/fy2); everything else
          // has a single fx/fy anchor.
          const moved=kind==='WALLS'
            ? (ia.fx1!==ib.fx1||ia.fy1!==ib.fy1||ia.fx2!==ib.fx2||ia.fy2!==ib.fy2)
            : (ia.fx!==ib.fx||ia.fy!==ib.fy);
          if(moved)out.push(`~ [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id} ${kind==='WALLS'?'reshaped':'moved'}`);
          // Field-level changes — the as-designed vs as-built story: identity,
          // wiring and rollout fields, not geometry.
          if(kind!=='WALLS'&&kind!=='DZS'){
            for(const fld of ['name','model','ip','vlan','port','swId','status','serial','channel','txPower']){
              const va=ia[fld]??'',vb=ib[fld]??'';
              if(String(va)!==String(vb))out.push(`~ [${fa.name||i}] ${kind.slice(0,-1)} ${ia.name||id}: ${fld} ${va===''?'(empty)':va} → ${vb===''?'(empty)':vb}`);
            }
          }
        }
      }
    }
  }
  return out;
}
