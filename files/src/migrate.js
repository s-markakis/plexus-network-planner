// Pure project-file migration logic. Lives in its own module so it can be
// unit-tested without booting the DOM/app shell.

import {WALL_MATERIALS} from './geometry.js';
import {AP_ANTENNA_GAIN_DBI,DEVICE_STATUSES} from './constants.js';

export const PROJECT_VERSION=11;

// Settings that apply project-wide (branding, RF assumptions, region, defaults).
// `coverageOpacity` / `lastModel` are user-preference style and live here too.
export const DEFAULT_SETTINGS={
  company:    'Plexus',
  tagline:    'Network Site Planner',
  contact:    '',
  locale:     'en-GB',
  metaLine:   '',
  reportTitle:'Network Audit Report',
  coverageOpacity: 100,
  lastModel:       'U6 Pro',
  // v8 additions
  propagationModel: 'logd',          // 'logd' | 'itu-indoor' | 'multi-wall'
  regulatoryRegion: 'FCC-US',         // key into REGULATORY_REGIONS
  noiseFloorDbm:    -95,              // for SNR/MCS/throughput maps
  floorSlabAttenDb: 18,               // floor-to-floor slab loss in dB
  showFloorLeakage: false,            // include neighbouring floors in heatmap
  heatmapMode:      'rssi',           // 'rssi' | 'snr' | 'mcs' | 'throughput'
  heatmapBand:      'all',            // 'all' | '2.4' | '5' | '6'
  showRoamingOverlap:false,           // overlay where ≥2 APs deliver ≥-67 dBm
  archScale:        '',               // optional architect-scale preset label
  logoDataUrl:      '',               // brand logo for report cover
  footerLine:       '',               // custom footer line in HTML/PDF exports
  language:         'en',             // i18n locale code
  // v9 additions
  cableRoutingFactor: 1.3,            // multiply straight-line runs to estimate real cabling
  cableBoxM:        305,              // metres per cable box (for BoM box count)
  expectedClients:  0,                // expected concurrent clients (0 = no capacity check)
  colorByVlan:      false,            // tint devices on the map by their VLAN colour
  vlans:            [],               // [{id,name,color,subnet}] VLAN registry
  customCatalog:    '',               // JSON string of merged custom vendor models
  // v9 (schema) additions — organization features
  siteCode:         '',               // short site tag for the naming convention, e.g. "HQ"
  namePattern:      '',               // device naming convention, e.g. "{site}-F{floor}-{type}{nn}"
  // v10 additions — SINR/airtime, camera DORI + storage, UniFi controller
  perClientMbps:    5,                // per-client demand (Mbps) for airtime estimates
  showDori:         true,             // render DORI pixel-density bands in camera cones
  retentionDays:    30,               // video retention for the storage calculator
  storageCodec:     'h265',           // 'h264' | 'h265' — scales camera bitrate estimates
  unifiUrl:         '',               // UniFi controller base URL (Electron builds only)
  unifiSite:        'default',        // UniFi site name
  unifiUser:        '',               // UniFi username (password is session-only)
};

const DEFAULT_FLOOR_SCALE_M=100;

// Upgrade a loaded project's data to the current schema in place.
// Returns [migratedData, warnings[]]. Throws on irrecoverable shape errors.
//
// Version history:
//   v1 → v2: ensure every AP has a model, every item has a locked flag.
//   v2 → v3: APs get channel + txPower defaults.
//   v3 → v4: each floor gets a WALLS array.
//   v4 → v5: floor images move to IndexedDB; settings live at the top level.
//   v5 → v6: walls store fractional coords; scaleM moves to per-floor.
//   v6 → v7: per-floor CAMS; APs gain pattern+heading; sw.poeBudget.
//   v7 → v8: APs gain antennaGainDbi/cableLossDb/mountHeightM/downtiltDeg/
//            capacityClients/txPowerDbm/comment; floors gain annotations[] and
//            surveySamples[]; project-level revisions[]; settings gain
//            propagation model / regulatory region / noise floor / slab loss
//            / heatmap mode + band / branding logo + footer.
//   v8 → v9: APs/cameras/switches gain install status + inventory fields
//            (serial/assetTag/firmware, mac everywhere); revisions gain a
//            baseline flag; settings gain siteCode + namePattern.
//   v9 → v10: APs gain chanWidth (MHz); cameras gain bitrateMbps (0 = auto
//            from resolution); settings gain perClientMbps/showDori/
//            retentionDays/storageCodec + UniFi controller fields.
//   v10 → v11: switches gain a `role` ('switch' | 'l3' — an L3 switch/router
//            that routes between VLANs); VLANs gain an optional `gateway` IP
//            (the SVI address), used by the packet simulator for inter-VLAN
//            routing. Both default empty/benign, so plans built pre-v11 behave
//            exactly as before until an L3 device and gateways are set.
export function migrateProject(data){
  const warnings=[];
  if(!data||typeof data!=='object'){throw new Error('Not a Plexus project file');}
  if(!Array.isArray(data.floors)){throw new Error('Missing floors');}
  const v=typeof data.version==='number'?data.version:1;
  if(v>PROJECT_VERSION){
    warnings.push(`Project was saved with a newer version (v${v}) — some fields may be ignored.`);
  }
  if(data.settings&&typeof data.settings==='object'){
    const s={};
    for(const k of Object.keys(DEFAULT_SETTINGS)){
      const got=data.settings[k];
      const def=DEFAULT_SETTINGS[k];
      if(Array.isArray(def)){
        if(Array.isArray(got))s[k]=got;
      }else if(typeof def==='number'){
        if(typeof got==='number'&&Number.isFinite(got))s[k]=got;
      }else if(typeof def==='boolean'){
        if(typeof got==='boolean')s[k]=got;
      }else{
        if(typeof got==='string')s[k]=got;
      }
    }
    data.settings={...DEFAULT_SETTINGS,...s};
  }else{
    data.settings={...DEFAULT_SETTINGS};
  }
  // Clone the VLAN registry so it never aliases the shared DEFAULT_SETTINGS array.
  // v11: carry an optional gateway IP (SVI) per VLAN for inter-VLAN routing sim.
  data.settings.vlans=Array.isArray(data.settings.vlans)?data.settings.vlans.map(v=>({...v,gateway:typeof v.gateway==='string'?v.gateway:''})):[];
  if(!Array.isArray(data.revisions))data.revisions=[];
  data.revisions.forEach(r=>{if(typeof r.baseline!=='boolean')r.baseline=false;});
  // v8→v9: install status + inventory fields on every networked device.
  const inv=(d)=>{
    if(!DEVICE_STATUSES.includes(d.status))d.status='planned';
    if(typeof d.serial!=='string')d.serial='';
    if(typeof d.assetTag!=='string')d.assetTag='';
    if(typeof d.firmware!=='string')d.firmware='';
    if(typeof d.mac!=='string')d.mac='';
  };
  // Project-level scaleM is the legacy default (pre-v6). New projects use
  // per-floor scaleM; old projects propagate the project-level value down.
  const projectScaleM=typeof data.scaleM==='number'&&data.scaleM>0?data.scaleM:DEFAULT_FLOOR_SCALE_M;
  data.floors.forEach(f=>{
    if(!f.imgId)f.imgId='';
    if(typeof f.scaleM!=='number'||f.scaleM<=0)f.scaleM=projectScaleM;
    (f.APS||[]).forEach(ap=>{
      if(!ap.model)ap.model='U6 Pro';
      if(typeof ap.locked!=='boolean')ap.locked=false;
      if(!ap.sig)ap.sig='strong';
      if(typeof ap.r!=='number'||ap.r<=0)ap.r=80;
      if(!ap.channel)ap.channel='auto';
      if(!ap.txPower)ap.txPower='auto';
      if(typeof ap.color!=='string')ap.color='';
      if(!ap.pattern)ap.pattern='omni';
      if(typeof ap.heading!=='number')ap.heading=0;
      if(typeof ap.swId!=='string')ap.swId='';
      // v7→v8
      if(typeof ap.antennaGainDbi!=='number'){
        ap.antennaGainDbi=AP_ANTENNA_GAIN_DBI[ap.model]??4;
      }
      if(typeof ap.cableLossDb!=='number')ap.cableLossDb=0;
      if(typeof ap.txPowerDbm!=='number')ap.txPowerDbm=20;
      if(typeof ap.mountHeightM!=='number')ap.mountHeightM=2.7;
      if(typeof ap.downtiltDeg!=='number')ap.downtiltDeg=0;
      if(typeof ap.capacityClients!=='number')ap.capacityClients=25;
      if(typeof ap.comment!=='string')ap.comment='';
      // v9→v10: channel width. 20 MHz keeps pre-v10 SNR/throughput unchanged.
      if(![20,40,80,160,320].includes(ap.chanWidth))ap.chanWidth=20;
      inv(ap);
    });
    (f.DZS||[]).forEach(dz=>{
      if(typeof dz.locked!=='boolean')dz.locked=false;
      if(typeof dz.r!=='number')dz.r=40;
      if(typeof dz.comment!=='string')dz.comment='';
    });
    (f.SWS||[]).forEach(sw=>{
      if(typeof sw.locked!=='boolean')sw.locked=false;
      if(typeof sw.size!=='number'||sw.size<=0)sw.size=22;
      if(typeof sw.poeBudget!=='number')sw.poeBudget=0;
      if(typeof sw.comment!=='string')sw.comment='';
      if(typeof sw.ports!=='number')sw.ports=0;        // 0 = derive from model
      if(typeof sw.uplinkId!=='string')sw.uplinkId='';
      if(sw.role!=='l3')sw.role='switch';              // v11: 'switch' | 'l3' (inter-VLAN router)
      inv(sw);
    });
    if(!Array.isArray(f.CAMS))f.CAMS=[];
    f.CAMS.forEach(cam=>{
      if(!cam.model)cam.model='G4 Pro';
      if(typeof cam.locked!=='boolean')cam.locked=false;
      if(typeof cam.fov!=='number'||cam.fov<=0)cam.fov=80;
      if(typeof cam.range!=='number'||cam.range<=0)cam.range=120;
      if(typeof cam.heading!=='number')cam.heading=0;
      if(typeof cam.color!=='string')cam.color='';
      if(typeof cam.swId!=='string')cam.swId='';
      if(!cam.resolution)cam.resolution='4K';
      if(typeof cam.comment!=='string')cam.comment='';
      // v9→v10: 0 = derive bitrate from resolution + codec in the calculator.
      if(typeof cam.bitrateMbps!=='number'||cam.bitrateMbps<0)cam.bitrateMbps=0;
      inv(cam);
    });
    if(!Array.isArray(f.WALLS))f.WALLS=[];
    f.WALLS.forEach(w=>{
      if(!w.material||!WALL_MATERIALS[w.material])w.material='drywall';
      if(typeof w.comment!=='string')w.comment='';
      if(!Number.isFinite(w.fx1)||!Number.isFinite(w.fy1)||!Number.isFinite(w.fx2)||!Number.isFinite(w.fy2)){
        if(Number.isFinite(w.x1)&&Number.isFinite(w.y1)&&Number.isFinite(w.x2)&&Number.isFinite(w.y2)
          &&Number.isFinite(f.imgW)&&Number.isFinite(f.imgH)&&f.imgW>0&&f.imgH>0){
          w.fx1=w.x1/f.imgW;w.fy1=w.y1/f.imgH;
          w.fx2=w.x2/f.imgW;w.fy2=w.y2/f.imgH;
          delete w.x1;delete w.y1;delete w.x2;delete w.y2;
        }
      }
    });
    // v7→v8: annotations and survey samples per floor.
    if(!Array.isArray(f.ANNOS))f.ANNOS=[];
    f.ANNOS.forEach(a=>{
      if(typeof a.kind!=='string')a.kind='text';
      if(typeof a.text!=='string')a.text='';
      if(typeof a.fx!=='number')a.fx=0.5;
      if(typeof a.fy!=='number')a.fy=0.5;
      if(typeof a.fx2!=='number')a.fx2=a.fx;
      if(typeof a.fy2!=='number')a.fy2=a.fy;
    });
    if(!Array.isArray(f.SAMPLES))f.SAMPLES=[];
    f.SAMPLES.forEach(s=>{
      if(typeof s.fx!=='number')s.fx=0;
      if(typeof s.fy!=='number')s.fy=0;
      if(typeof s.rssi!=='number')s.rssi=-95;
    });
    // v11: wireless clients (associate to the best AP by signal in the sim).
    if(!Array.isArray(f.CLIENTS))f.CLIENTS=[];
    f.CLIENTS.forEach(c=>{
      if(typeof c.name!=='string')c.name='Client';
      if(typeof c.ip!=='string')c.ip='dhcp';
      if(typeof c.vlan!=='string')c.vlan='';
      if(typeof c.locked!=='boolean')c.locked=false;
    });
  });
  delete data.scaleM;
  data.version=PROJECT_VERSION;
  return [data,warnings];
}

// Walk every item in every floor and find the highest numeric suffix on its
// id. Returns the next free suffix (max+1). Used after loading a project so
// the global `nid` counter doesn't collide with existing IDs.
export function syncNidFromFloors(floors){
  let maxNum=0;
  for(const f of floors){
    for(const list of [f.APS,f.DZS,f.SWS,f.WALLS,f.CAMS,f.CLIENTS,f.ANNOS,f.SAMPLES]){
      if(!Array.isArray(list))continue;
      for(const item of list){
        if(!item.id)continue;
        const m=String(item.id).match(/(\d+)$/);
        if(m){
          const n=parseInt(m[1],10);
          if(n>maxNum)maxNum=n;
        }
      }
    }
  }
  return maxNum+1;
}

// Pick the next available numeric suffix for an AP/DZ/SW name.
export function nextNameSuffix(items,prefixRegex){
  let max=0;
  for(const it of items){
    const m=String(it.name||'').match(prefixRegex);
    if(m){const n=parseInt(m[1],10);if(n>max)max=n;}
  }
  return max+1;
}
