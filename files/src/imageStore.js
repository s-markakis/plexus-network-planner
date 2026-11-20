// IndexedDB-backed floor-plan image store. Floor objects keep only an
// `imgId` reference; the actual data URL lives here so save/autosave
// payloads stay tiny (otherwise multi-megabyte images would blow past
// the 5 MB localStorage quota on every tick).

const IDB_NAME='noctis_wifi';
const IDB_STORE='images';
const IDB_VERSION=1;
let _idbPromise=null;

function _openIdb(){
  if(_idbPromise)return _idbPromise;
  _idbPromise=new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined'){reject(new Error('No IndexedDB'));return;}
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return _idbPromise;
}

export async function idbPutImage(id,dataUrl){
  const db=await _openIdb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put(dataUrl,id);
    tx.oncomplete=()=>resolve(undefined);
    tx.onerror=()=>reject(tx.error);
  });
}

export async function idbGetImage(id){
  const db=await _openIdb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(IDB_STORE,'readonly');
    const r=tx.objectStore(IDB_STORE).get(id);
    r.onsuccess=()=>resolve(r.result||null);
    r.onerror=()=>reject(r.error);
  });
}

export async function idbDeleteImage(id){
  if(!id)return;
  const db=await _openIdb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete=()=>resolve(undefined);
    tx.onerror=()=>reject(tx.error);
  });
}

export function newImgId(){
  return 'img_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
}

// In-memory cache so multiple loads of the same image don't re-hit IDB.
export const imgCache=new Map();

export async function resolveFloorImage(f){
  if(!f.imgId)return '';
  if(imgCache.has(f.imgId))return imgCache.get(f.imgId);
  const data=await idbGetImage(f.imgId);
  if(data)imgCache.set(f.imgId,data);
  return data||'';
}
