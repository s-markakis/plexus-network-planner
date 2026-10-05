import {describe,test,expect} from 'vitest';
import {migrateProject,syncNidFromFloors,nextNameSuffix,PROJECT_VERSION,DEFAULT_SETTINGS} from '../files/src/migrate.js';

const baseAP={id:'ap1',name:'AP-01',fx:0.5,fy:0.5,r:80};

describe('migrateProject',()=>{
  test('throws on non-object',()=>{
    expect(()=>migrateProject(null)).toThrow();
    expect(()=>migrateProject('hi')).toThrow();
  });
  test('throws on missing floors',()=>{
    expect(()=>migrateProject({version:1})).toThrow(/floors/i);
  });
  test('v1 → current: fills AP defaults',()=>{
    const [data]=migrateProject({version:1,floors:[{id:'f1',APS:[{id:'ap1',fx:.5,fy:.5}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.model).toBe('U6 Pro');
    expect(ap.locked).toBe(false);
    expect(ap.sig).toBe('strong');
    expect(ap.r).toBe(80);
    expect(ap.channel).toBe('auto');
    expect(ap.txPower).toBe('auto');
    expect(ap.color).toBe('');
    expect(data.version).toBe(PROJECT_VERSION);
  });
  test('v3 → current: adds WALLS array per floor',()=>{
    const [data]=migrateProject({version:3,floors:[{id:'f1',APS:[],DZS:[],SWS:[]}]});
    expect(Array.isArray(data.floors[0].WALLS)).toBe(true);
  });
  test('v4 → current: adds settings + imgId',()=>{
    const [data]=migrateProject({version:4,floors:[{id:'f1',APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.company).toBe(DEFAULT_SETTINGS.company);
    expect(data.floors[0].imgId).toBe('');
  });
  test('settings merge keeps user overrides',()=>{
    const [data]=migrateProject({version:5,settings:{company:'ACME',contact:'x@y.com'},floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.company).toBe('ACME');
    expect(data.settings.contact).toBe('x@y.com');
    expect(data.settings.locale).toBe(DEFAULT_SETTINGS.locale);
  });
  test('settings ignores non-string values for string fields',()=>{
    const [data]=migrateProject({version:5,settings:{company:123,contact:null,tagline:{}},floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.company).toBe(DEFAULT_SETTINGS.company);
  });
  test('newer version returns warning',()=>{
    const [,warnings]=migrateProject({version:99,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/newer/i);
  });
  test('coerces invalid wall material to drywall',()=>{
    const [data]=migrateProject({version:4,floors:[{APS:[],DZS:[],SWS:[],WALLS:[{x1:0,y1:0,x2:1,y2:1,material:'mystery-material'}]}]});
    expect(data.floors[0].WALLS[0].material).toBe('drywall');
  });
  test('preserves valid AP r',()=>{
    const ap={...baseAP,r:42};
    const [data]=migrateProject({version:4,floors:[{APS:[ap],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.floors[0].APS[0].r).toBe(42);
  });
  test('coerces zero/NaN r → 80',()=>{
    const [data]=migrateProject({version:4,floors:[{APS:[{...baseAP,r:0}],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.floors[0].APS[0].r).toBe(80);
  });
});

describe('syncNidFromFloors',()=>{
  test('returns 1 for empty floors',()=>{
    expect(syncNidFromFloors([{APS:[],DZS:[],SWS:[],WALLS:[]}])).toBe(1);
  });
  test('finds highest numeric suffix across types',()=>{
    const floors=[{APS:[{id:'ap5'},{id:'ap22'}],DZS:[{id:'dz3'}],SWS:[{id:'sw7'}],WALLS:[{id:'w19'}]}];
    expect(syncNidFromFloors(floors)).toBe(23);
  });
  test('walks multiple floors',()=>{
    const floors=[
      {APS:[{id:'ap1'}],DZS:[],SWS:[],WALLS:[]},
      {APS:[{id:'ap99'}],DZS:[],SWS:[],WALLS:[]},
    ];
    expect(syncNidFromFloors(floors)).toBe(100);
  });
  test('ignores ids without numeric suffix',()=>{
    const floors=[{APS:[{id:'apX'},{id:'ap5'}],DZS:[],SWS:[],WALLS:[]}];
    expect(syncNidFromFloors(floors)).toBe(6);
  });
  test('also walks ANNOS / SAMPLES (v8)',()=>{
    const floors=[{APS:[],DZS:[],SWS:[],WALLS:[],ANNOS:[{id:'an50'}],SAMPLES:[{id:'s60'}]}];
    expect(syncNidFromFloors(floors)).toBe(61);
  });
});

describe('migrateProject — v5 → v6 (per-floor scaleM + fractional walls)',()=>{
  test('legacy project-level scaleM propagates to every floor',()=>{
    const [data]=migrateProject({
      version:5,scaleM:150,
      floors:[{APS:[],DZS:[],SWS:[],WALLS:[]},{APS:[],DZS:[],SWS:[],WALLS:[]}],
    });
    expect(data.floors[0].scaleM).toBe(150);
    expect(data.floors[1].scaleM).toBe(150);
    expect(data.scaleM).toBeUndefined();
  });
  test('missing scaleM defaults to 100',()=>{
    const [data]=migrateProject({version:5,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.floors[0].scaleM).toBe(100);
  });
  test('per-floor scaleM honoured if already set',()=>{
    const [data]=migrateProject({
      version:6,scaleM:200,
      floors:[{APS:[],DZS:[],SWS:[],WALLS:[],scaleM:42}],
    });
    expect(data.floors[0].scaleM).toBe(42);
  });
  test('walls with stored imgW/imgH are converted to fractional',()=>{
    const [data]=migrateProject({
      version:5,
      floors:[{
        imgW:1000,imgH:500,APS:[],DZS:[],SWS:[],
        WALLS:[{id:'w1',x1:100,y1:100,x2:500,y2:300,material:'brick'}],
      }],
    });
    const w=data.floors[0].WALLS[0];
    expect(w.fx1).toBeCloseTo(0.1,5);
    expect(w.fy1).toBeCloseTo(0.2,5);
    expect(w.fx2).toBeCloseTo(0.5,5);
    expect(w.fy2).toBeCloseTo(0.6,5);
    expect(w.x1).toBeUndefined();
  });
  test('walls without imgW/imgH stay legacy until geometry resolves them',()=>{
    const [data]=migrateProject({
      version:5,
      floors:[{APS:[],DZS:[],SWS:[],WALLS:[{x1:1,y1:2,x2:3,y2:4,material:'wood'}]}],
    });
    const w=data.floors[0].WALLS[0];
    expect(w.x1).toBe(1);
    expect(w.fx1).toBeUndefined();
  });
});

describe('migrateProject — settings keys',()=>{
  test('coverageOpacity defaults to 100',()=>{
    const [data]=migrateProject({version:5,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.coverageOpacity).toBe(100);
  });
  test('coverageOpacity honoured when set as a number',()=>{
    const [data]=migrateProject({
      version:6,settings:{coverageOpacity:55},
      floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}],
    });
    expect(data.settings.coverageOpacity).toBe(55);
  });
  test('lastModel defaults to U6 Pro',()=>{
    const [data]=migrateProject({version:5,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.lastModel).toBe('U6 Pro');
  });
});

describe('migrateProject — v6 → v7 (cameras, antenna patterns, PoE)',()=>{
  test('every floor gets a CAMS array',()=>{
    const [data]=migrateProject({version:6,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(Array.isArray(data.floors[0].CAMS)).toBe(true);
  });
  test('existing CAMS are preserved + filled with defaults',()=>{
    const [data]=migrateProject({version:6,floors:[{APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[{id:'cm1',name:'CAM-01',fx:.5,fy:.5}]}]});
    const c=data.floors[0].CAMS[0];
    expect(c.model).toBe('G4 Pro');
    expect(c.fov).toBe(80);
    expect(c.range).toBe(120);
    expect(c.heading).toBe(0);
    expect(c.locked).toBe(false);
    expect(c.resolution).toBe('4K');
  });
  test('APs gain pattern + heading defaults',()=>{
    const [data]=migrateProject({version:6,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.pattern).toBe('omni');
    expect(ap.heading).toBe(0);
    expect(ap.swId).toBe('');
  });
  test('APs keep an explicit pattern when set',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80,pattern:'sector-90',heading:90}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.pattern).toBe('sector-90');
    expect(ap.heading).toBe(90);
  });
  test('switches gain a poeBudget default',()=>{
    const [data]=migrateProject({version:6,floors:[{APS:[],DZS:[],SWS:[{id:'sw1',name:'SW-1'}],WALLS:[]}]});
    expect(data.floors[0].SWS[0].poeBudget).toBe(0);
  });
  test('switches keep an explicit poeBudget',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[],DZS:[],SWS:[{id:'sw1',name:'SW-1',poeBudget:250}],WALLS:[]}]});
    expect(data.floors[0].SWS[0].poeBudget).toBe(250);
  });
});

describe('migrateProject — v7 → v8 (antenna fidelity, regions, annotations, samples, revisions)',()=>{
  test('APs gain antennaGainDbi seeded from the model table',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80,model:'U6 Pro'}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.antennaGainDbi).toBeGreaterThan(0);
    expect(ap.cableLossDb).toBe(0);
    expect(ap.txPowerDbm).toBe(20);
    expect(ap.mountHeightM).toBeGreaterThan(0);
    expect(typeof ap.downtiltDeg).toBe('number');
    expect(ap.capacityClients).toBeGreaterThan(0);
    expect(typeof ap.comment).toBe('string');
  });
  test('APs keep explicit antenna fidelity overrides',()=>{
    const [data]=migrateProject({version:8,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80,antennaGainDbi:8,cableLossDb:2,txPowerDbm:23,mountHeightM:3.5,downtiltDeg:10,capacityClients:60}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.antennaGainDbi).toBe(8);
    expect(ap.cableLossDb).toBe(2);
    expect(ap.txPowerDbm).toBe(23);
    expect(ap.mountHeightM).toBe(3.5);
    expect(ap.downtiltDeg).toBe(10);
    expect(ap.capacityClients).toBe(60);
  });
  test('every floor gets ANNOS + SAMPLES arrays',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(Array.isArray(data.floors[0].ANNOS)).toBe(true);
    expect(Array.isArray(data.floors[0].SAMPLES)).toBe(true);
  });
  test('project-level revisions array is created',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(Array.isArray(data.revisions)).toBe(true);
  });
  test('new settings keys are defaulted',()=>{
    const [data]=migrateProject({version:7,floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.propagationModel).toBe('logd');
    expect(data.settings.regulatoryRegion).toBe('FCC-US');
    expect(data.settings.noiseFloorDbm).toBe(-95);
    expect(data.settings.floorSlabAttenDb).toBe(18);
    expect(data.settings.showFloorLeakage).toBe(false);
    expect(data.settings.heatmapMode).toBe('rssi');
    expect(data.settings.heatmapBand).toBe('all');
    expect(data.settings.language).toBe('en');
  });
  test('new boolean settings respect explicit values',()=>{
    const [data]=migrateProject({version:8,settings:{showFloorLeakage:true,showRoamingOverlap:true},floors:[{APS:[],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.settings.showFloorLeakage).toBe(true);
    expect(data.settings.showRoamingOverlap).toBe(true);
  });
  test('all device types gain a comment string',()=>{
    const [data]=migrateProject({version:7,floors:[{
      APS:[{id:'ap1',fx:.5,fy:.5,r:80}],
      DZS:[{id:'dz1',fx:.5,fy:.5,r:40}],
      SWS:[{id:'sw1',name:'SW-1'}],
      CAMS:[{id:'cm1',fx:.5,fy:.5}],
      WALLS:[{material:'drywall',fx1:0,fy1:0,fx2:1,fy2:1}],
    }]});
    expect(data.floors[0].APS[0].comment).toBe('');
    expect(data.floors[0].DZS[0].comment).toBe('');
    expect(data.floors[0].SWS[0].comment).toBe('');
    expect(data.floors[0].CAMS[0].comment).toBe('');
    expect(data.floors[0].WALLS[0].comment).toBe('');
  });
});

describe('nextNameSuffix',()=>{
  test('starts at 1 with no items',()=>{
    expect(nextNameSuffix([],/^AP-(\d+)/)).toBe(1);
  });
  test('finds the gap-aware max+1',()=>{
    const items=[{name:'AP-01'},{name:'AP-05'},{name:'AP-03'}];
    expect(nextNameSuffix(items,/^AP-(\d+)/)).toBe(6);
  });
  test('ignores non-matching names',()=>{
    const items=[{name:'AP-02'},{name:'random'},{name:'Custom Name'}];
    expect(nextNameSuffix(items,/^AP-(\d+)/)).toBe(3);
  });
});

describe('migrateProject — v8 → v9 (install status, inventory, naming, baselines)',()=>{
  const floors=()=>[{
    APS:[{id:'ap1',fx:.5,fy:.5,r:80}],
    SWS:[{id:'sw1',name:'SW-1'}],
    CAMS:[{id:'cm1',fx:.5,fy:.5}],
    DZS:[],WALLS:[],
  }];
  test('devices gain status + inventory fields',()=>{
    const [data]=migrateProject({version:8,floors:floors()});
    for(const d of [data.floors[0].APS[0],data.floors[0].SWS[0],data.floors[0].CAMS[0]]){
      expect(d.status).toBe('planned');
      expect(d.serial).toBe('');
      expect(d.assetTag).toBe('');
      expect(d.firmware).toBe('');
      expect(d.mac).toBe('');
    }
  });
  test('explicit status and inventory values survive',()=>{
    const [data]=migrateProject({version:9,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80,status:'live',serial:'S123',assetTag:'A-9',firmware:'6.5.28',mac:'aa:bb:cc:dd:ee:ff'}],DZS:[],SWS:[],WALLS:[]}]});
    const ap=data.floors[0].APS[0];
    expect(ap.status).toBe('live');
    expect(ap.serial).toBe('S123');
    expect(ap.assetTag).toBe('A-9');
    expect(ap.firmware).toBe('6.5.28');
    expect(ap.mac).toBe('aa:bb:cc:dd:ee:ff');
  });
  test('an unknown status is reset to planned',()=>{
    const [data]=migrateProject({version:9,floors:[{APS:[{id:'ap1',fx:.5,fy:.5,r:80,status:'shipped'}],DZS:[],SWS:[],WALLS:[]}]});
    expect(data.floors[0].APS[0].status).toBe('planned');
  });
  test('revisions gain a baseline flag, existing flags survive',()=>{
    const [data]=migrateProject({version:8,revisions:[{id:'rev1',name:'a',snapshot:[]},{id:'rev2',name:'b',snapshot:[],baseline:true}],floors:floors()});
    expect(data.revisions[0].baseline).toBe(false);
    expect(data.revisions[1].baseline).toBe(true);
  });
  test('siteCode and namePattern settings default to empty strings',()=>{
    const [data]=migrateProject({version:8,floors:floors()});
    expect(data.settings.siteCode).toBe('');
    expect(data.settings.namePattern).toBe('');
  });
  test('PROJECT_VERSION is stamped',()=>{
    const [data]=migrateProject({version:8,floors:floors()});
    expect(data.version).toBe(PROJECT_VERSION);
    expect(PROJECT_VERSION).toBe(11);
  });
  // v9 → v10
  test('APs gain a 20 MHz channel width; junk widths are normalized',()=>{
    const [data]=migrateProject({version:9,floors:[{APS:[{...baseAP},{...baseAP,id:'ap2',chanWidth:80},{...baseAP,id:'ap3',chanWidth:33}],DZS:[],SWS:[],WALLS:[]}]});
    const [a,b,c]=data.floors[0].APS;
    expect(a.chanWidth).toBe(20);
    expect(b.chanWidth).toBe(80);
    expect(c.chanWidth).toBe(20);
  });
  test('cameras gain bitrateMbps=0 (auto)',()=>{
    const [data]=migrateProject({version:9,floors:[{APS:[],DZS:[],SWS:[],WALLS:[],CAMS:[{id:'cm1',fx:.5,fy:.5},{id:'cm2',fx:.5,fy:.5,bitrateMbps:6}]}]});
    expect(data.floors[0].CAMS[0].bitrateMbps).toBe(0);
    expect(data.floors[0].CAMS[1].bitrateMbps).toBe(6);
  });
  test('v10 settings defaults: airtime, DORI/storage, UniFi',()=>{
    const [data]=migrateProject({version:9,floors:floors()});
    expect(data.settings.perClientMbps).toBe(5);
    expect(data.settings.showDori).toBe(true);
    expect(data.settings.retentionDays).toBe(30);
    expect(data.settings.storageCodec).toBe('h265');
    expect(data.settings.unifiUrl).toBe('');
    expect(data.settings.unifiSite).toBe('default');
  });
});
