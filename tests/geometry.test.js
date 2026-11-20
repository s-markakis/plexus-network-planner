import {describe,test,expect} from 'vitest';
import {
  attenuationFactor,
  rayWallIntersect,
  computeCoveragePath,
  coveredThroughWalls,
  sampleFloorCoverage,
  sampleRoamingOverlap,
  WALL_MATERIALS,
  BAND_LOSS,
  bandLossMultiplier,
  wallToPx,
  dbmAt,
  snrAt,
  mcsFromSnr,
  mbpsAt,
  effectiveEirp,
  dbmAtThroughSlab,
} from '../files/src/geometry.js';

describe('attenuationFactor',()=>{
  test('zero loss → full reach',()=>{
    expect(attenuationFactor(0)).toBe(1);
  });
  test('3 dB ≈ half range',()=>{
    expect(attenuationFactor(3)).toBeCloseTo(0.5,5);
  });
  test('6 dB ≈ quarter range',()=>{
    expect(attenuationFactor(6)).toBeCloseTo(0.25,5);
  });
  test('clamped at 0.05 floor',()=>{
    expect(attenuationFactor(1000)).toBe(0.05);
  });
  test('never returns NaN for finite input',()=>{
    for(const db of [0,1,3,7.5,15,30,99]){
      expect(Number.isFinite(attenuationFactor(db))).toBe(true);
    }
  });
});

describe('rayWallIntersect',()=>{
  test('perpendicular crossing returns midpoint t',()=>{
    const t=rayWallIntersect(0,0,10,0, 5,-5, 5,5);
    expect(t).toBeCloseTo(0.5,5);
  });
  test('parallel rays don\'t intersect',()=>{
    const t=rayWallIntersect(0,0,10,0, 0,1, 10,1);
    expect(t).toBeNull();
  });
  test('hit beyond ray endpoint returns null',()=>{
    const t=rayWallIntersect(0,0,1,0, 5,-1, 5,1);
    expect(t).toBeNull();
  });
  test('hit before ray start returns null',()=>{
    const t=rayWallIntersect(10,0,20,0, 5,-1, 5,1);
    expect(t).toBeNull();
  });
});

describe('coveredThroughWalls',()=>{
  const ap={fx:0.5,fy:0.5,r:100};
  const w=200,h=200;
  test('point inside r with no walls is covered',()=>{
    expect(coveredThroughWalls(ap,150,100,w,h,[])).toBe(true);
  });
  test('point outside r is never covered',()=>{
    expect(coveredThroughWalls(ap,300,100,w,h,[])).toBe(false);
  });
  test('thick concrete wall blocks short range',()=>{
    const wall={x1:120,y1:0,x2:120,y2:200,material:'concrete'};
    expect(coveredThroughWalls(ap,150,100,w,h,[wall])).toBe(false);
  });
  test('drywall barely affects coverage',()=>{
    const wall={x1:120,y1:0,x2:120,y2:200,material:'drywall'};
    expect(coveredThroughWalls(ap,140,100,w,h,[wall])).toBe(true);
  });
});

describe('computeCoveragePath',()=>{
  test('no walls → polygon approximating circle',()=>{
    const path=computeCoveragePath({fx:0.5,fy:0.5,r:50},200,200,[]);
    expect(path).toMatch(/^M[\d.,LZ -]+Z$/);
    expect((path.match(/L/g)||[]).length).toBe(71);
  });
  test('zero-image-size returns empty path',()=>{
    expect(computeCoveragePath({fx:0.5,fy:0.5,r:50},0,0,[])).toBe('M0,0Z');
  });
  test('invalid AP returns empty path',()=>{
    expect(computeCoveragePath({fx:NaN,fy:0.5,r:50},200,200,[])).toBe('M0,0Z');
    expect(computeCoveragePath({fx:0.5,fy:0.5,r:0},200,200,[])).toBe('M0,0Z');
  });
});

describe('sampleFloorCoverage',()=>{
  test('no APs → 0/0',()=>{
    expect(sampleFloorCoverage({APS:[],WALLS:[]},200,200)).toEqual({covered:0,total:0});
  });
  test('one AP covering most of floor',()=>{
    const r=sampleFloorCoverage({APS:[{fx:0.5,fy:0.5,r:200}],WALLS:[]},200,200);
    expect(r.covered).toBeGreaterThan(0);
    expect(r.covered/r.total).toBeGreaterThan(0.5);
  });
  test('walls reduce coverage versus no walls',()=>{
    const aps=[{fx:0.5,fy:0.5,r:80}];
    const noWalls=sampleFloorCoverage({APS:aps,WALLS:[]},200,200);
    const withWalls=sampleFloorCoverage({APS:aps,WALLS:[
      {x1:90,y1:0,x2:90,y2:200,material:'concrete'},
      {x1:110,y1:0,x2:110,y2:200,material:'concrete'},
    ]},200,200);
    expect(withWalls.covered).toBeLessThan(noWalls.covered);
  });
});

describe('bandLossMultiplier',()=>{
  test('5 GHz baseline is 1.0',()=>{
    expect(bandLossMultiplier('5 GHz only')).toBe(1.0);
  });
  test('2.4 GHz penetrates better (factor < 1)',()=>{
    expect(bandLossMultiplier('2.4 GHz only')).toBeLessThan(1);
    expect(bandLossMultiplier('2.4 / 5 GHz')).toBeLessThan(1);
  });
  test('6 GHz penetrates worse (factor > 1)',()=>{
    expect(bandLossMultiplier('6 GHz (WiFi 6E)')).toBeGreaterThan(1);
  });
  test('unknown band falls back to 1.0',()=>{
    expect(bandLossMultiplier('mystery')).toBe(1.0);
    expect(bandLossMultiplier(undefined)).toBe(1.0);
  });
  test('2.4 GHz coverage reaches further through walls than 5 GHz',()=>{
    const ap={fx:0.5,fy:0.5,r:100};
    const walls=[{x1:120,y1:0,x2:120,y2:200,material:'drywall'}];
    expect(coveredThroughWalls(ap,160,100,200,200,walls,1.0)).toBe(false);
    expect(coveredThroughWalls(ap,160,100,200,200,walls,0.6)).toBe(true);
  });
});

describe('wallToPx',()=>{
  test('resolves fractional walls against image size',()=>{
    expect(wallToPx({fx1:0.1,fy1:0.2,fx2:0.5,fy2:0.6},1000,500)).toEqual({x1:100,y1:100,x2:500,y2:300});
  });
  test('passes through legacy pixel walls untouched',()=>{
    expect(wallToPx({x1:10,y1:20,x2:30,y2:40},1000,500)).toEqual({x1:10,y1:20,x2:30,y2:40});
  });
  test('prefers fractional when both are present',()=>{
    expect(wallToPx({fx1:0.5,fy1:0.5,fx2:0.5,fy2:0.5,x1:9,y1:9,x2:9,y2:9},100,100)).toEqual({x1:50,y1:50,x2:50,y2:50});
  });
});

describe('computeCoveragePath with fractional walls',()=>{
  test('matches pixel-wall output for the same geometry',()=>{
    const ap={fx:0.5,fy:0.5,r:50};
    const pxWall=[{x1:90,y1:0,x2:90,y2:200,material:'concrete'}];
    const fxWall=[{fx1:90/200,fy1:0,fx2:90/200,fy2:1,material:'concrete'}];
    const pxPath=computeCoveragePath(ap,200,200,pxWall);
    const fxPath=computeCoveragePath(ap,200,200,fxWall);
    expect(fxPath).toBe(pxPath);
  });
});

describe('BAND_LOSS table',()=>{
  test('has expected keys',()=>{
    expect(Object.keys(BAND_LOSS).sort()).toEqual([
      '2.4 / 5 GHz','2.4 GHz only','5 GHz only','6 GHz (WiFi 6E)',
    ].sort());
  });
});

describe('computeCoveragePath with directional pattern',()=>{
  test('omni covers all angles',()=>{
    const path=computeCoveragePath({fx:0.5,fy:0.5,r:50},200,200,[],{arcDeg:180,headingDeg:0});
    const matches=path.match(/-?\d+\.\d+,-?\d+\.\d+/g);
    expect(matches.length).toBe(72);
  });
  test('narrow sector (arcDeg=15) leaves most rays collapsed near the centre',()=>{
    const path=computeCoveragePath({fx:0.5,fy:0.5,r:100},200,200,[],{arcDeg:15,headingDeg:0});
    const pts=path.slice(1,-1).split(/[ML]/).filter(Boolean).map(p=>p.split(',').map(Number));
    const farFromCentre=pts.filter(([x,y])=>Math.hypot(x-100,y-100)>20).length;
    expect(farFromCentre).toBeLessThan(20);
    expect(farFromCentre).toBeGreaterThan(0);
  });
});

describe('dbmAt',()=>{
  const ap={fx:0.5,fy:0.5,r:100};
  test('returns null beyond range',()=>{
    expect(dbmAt(ap,250,100,200,200,[])).toBeNull();
  });
  test('returns a number inside range',()=>{
    const d=dbmAt(ap,120,100,200,200,[]);
    expect(d).not.toBeNull();
    expect(d).toBeLessThan(-30);
    expect(d).toBeGreaterThan(-95);
  });
  test('closer-to-AP means stronger signal',()=>{
    const near=dbmAt(ap,110,100,200,200,[]);
    const far=dbmAt(ap,180,100,200,200,[]);
    expect(near).toBeGreaterThan(far);
  });
  test('directional gating excludes points outside the cone',()=>{
    expect(dbmAt(ap,100,180,200,200,[],{arcDeg:15,headingDeg:0})).toBeNull();
    expect(dbmAt(ap,180,100,200,200,[],{arcDeg:15,headingDeg:0})).not.toBeNull();
  });
  test('walls drop the dBm value',()=>{
    const walls=[{x1:110,y1:0,x2:110,y2:200,material:'brick'}];
    const open=dbmAt(ap,120,100,200,200,[]);
    const blocked=dbmAt(ap,120,100,200,200,walls);
    if(blocked!==null)expect(blocked).toBeLessThan(open-5);
  });
  test('EIRP boost raises the dBm reading',()=>{
    const base=dbmAt(ap,120,100,200,200,[]);
    const boosted=dbmAt(ap,120,100,200,200,[],{eirpDbm:30});
    expect(boosted-base).toBeCloseTo(10,4);
  });
  test('itu-indoor model attenuates faster than log-distance',()=>{
    const logd=dbmAt(ap,160,100,200,200,[],{model:'logd'});
    const itu =dbmAt(ap,160,100,200,200,[],{model:'itu-indoor'});
    expect(itu).toBeLessThan(logd);
  });
  test('multi-wall model attenuates even faster than itu-indoor',()=>{
    const itu=dbmAt(ap,160,100,200,200,[],{model:'itu-indoor'});
    const mw =dbmAt(ap,160,100,200,200,[],{model:'multi-wall'});
    expect(mw).toBeLessThan(itu);
  });
});

describe('effectiveEirp',()=>{
  test('default: 20 dBm txPower, 0 gain, 0 loss = 20 dBm EIRP',()=>{
    expect(effectiveEirp({fx:0.5,fy:0.5,r:100})).toBe(20);
  });
  test('adds antenna gain and subtracts cable loss',()=>{
    expect(effectiveEirp({txPowerDbm:23,antennaGainDbi:5,cableLossDb:1.5})).toBeCloseTo(26.5,5);
  });
});

describe('snrAt + mcsFromSnr + mbpsAt',()=>{
  const ap={fx:0.5,fy:0.5,r:100,freq:'5 GHz only'};
  test('SNR = dBm − noiseFloor',()=>{
    const dbm=dbmAt(ap,120,100,200,200,[]);
    const snr=snrAt(ap,120,100,200,200,[]);
    expect(snr-dbm).toBeCloseTo(95,5);
  });
  test('null when out of range',()=>{
    expect(snrAt(ap,250,100,200,200,[])).toBeNull();
    expect(mbpsAt(ap,250,100,200,200,[])).toBe(0);
  });
  test('SNR ≥ 28 dB returns MCS 7 or higher',()=>{
    expect(mcsFromSnr(28)).toBeGreaterThanOrEqual(7);
    expect(mcsFromSnr(34)).toBeGreaterThanOrEqual(9);
  });
  test('SNR < 5 dB returns MCS -1 (no link)',()=>{
    expect(mcsFromSnr(3)).toBe(-1);
  });
  test('mbpsAt scales with band stream multiplier (6 GHz > 5 GHz > 2.4 GHz)',()=>{
    const a24={...ap,freq:'2.4 GHz only',r:100};
    const a5 ={...ap,freq:'5 GHz only', r:100};
    const a6 ={...ap,freq:'6 GHz (WiFi 6E)',r:100};
    const m24=mbpsAt(a24,110,100,200,200,[]);
    const m5 =mbpsAt(a5 ,110,100,200,200,[]);
    const m6 =mbpsAt(a6 ,110,100,200,200,[]);
    expect(m6).toBeGreaterThan(m5);
    expect(m5).toBeGreaterThan(m24);
  });
});

describe('sampleRoamingOverlap',()=>{
  test('zero APs → 0/0',()=>{
    expect(sampleRoamingOverlap({APS:[],WALLS:[]},200,200)).toEqual({covered:0,total:0});
  });
  test('one AP → 0/0 (need at least two)',()=>{
    expect(sampleRoamingOverlap({APS:[{fx:.5,fy:.5,r:200}],WALLS:[]},200,200).covered).toBe(0);
  });
  test('two overlapping APs produce a non-zero overlap area',()=>{
    const r=sampleRoamingOverlap({APS:[
      {fx:0.4,fy:0.5,r:300},
      {fx:0.6,fy:0.5,r:300},
    ],WALLS:[]},200,200,-90);
    expect(r.covered).toBeGreaterThan(0);
  });
});

describe('dbmAtThroughSlab across several floors',()=>{
  const ap={fx:0.5,fy:0.5,r:400,freq:'5 GHz only',txPowerDbm:20,antennaGainDbi:3};
  const at=(slabs,vertM)=>dbmAtThroughSlab(ap,100,100,200,200,18,1.0,'logd',0.1,slabs,vertM);
  test('each extra slab costs exactly one more slab loss at the same path length',()=>{
    const one=at(1,3),two=at(2,3);
    expect(one-two).toBeCloseTo(18,6);
  });
  test('vertical separation lengthens the path: directly below is not zero distance',()=>{
    const flat=at(1,0),below3=at(1,3),below6=at(1,6);
    expect(below3).toBeLessThan(flat);
    expect(below6).toBeLessThan(below3);
  });
  test('the path is the 3-D distance (3-4-5 triangle)',()=>{
    // 40 px at 0.1 m/px = 4 m horizontal, 3 m vertical → 5 m; same as 50 px flat.
    const diag=dbmAtThroughSlab(ap,140,100,200,200,18,1.0,'logd',0.1,1,3);
    const flat=dbmAtThroughSlab(ap,150,100,200,200,18,1.0,'logd',0.1,1,0);
    expect(diag).toBeCloseTo(flat,6);
  });
  test('omitting the new arguments keeps the single-slab, same-plane result',()=>{
    expect(dbmAtThroughSlab(ap,150,100,200,200,18,1.0,'logd',0.1)).toBeCloseTo(dbmAtThroughSlab(ap,150,100,200,200,18,1.0,'logd',0.1,1,0),9);
  });
});
describe('dbmAtThroughSlab',()=>{
  test('returns null beyond range',()=>{
    expect(dbmAtThroughSlab({fx:0.5,fy:0.5,r:100},250,100,200,200,18,1.0)).toBeNull();
  });
  test('slab attenuation drops dBm vs direct',()=>{
    const ap={fx:0.5,fy:0.5,r:200};
    const direct=dbmAt(ap,150,100,200,200,[]);
    const throughSlab=dbmAtThroughSlab(ap,150,100,200,200,18,1.0);
    if(throughSlab!==null)expect(throughSlab).toBeLessThan(direct-10);
  });
});

describe('WALL_MATERIALS table',()=>{
  test('contains the five expected keys',()=>{
    expect(Object.keys(WALL_MATERIALS).sort()).toEqual(['brick','concrete','drywall','glass','wood']);
  });
  test('losses are monotonic drywall < wood < glass < brick < concrete',()=>{
    const {drywall,wood,glass,brick,concrete}=WALL_MATERIALS;
    expect(drywall.loss).toBeLessThan(wood.loss);
    expect(wood.loss).toBeLessThan(glass.loss);
    expect(glass.loss).toBeLessThan(brick.loss);
    expect(brick.loss).toBeLessThan(concrete.loss);
  });
});

describe('dbmAt physical model (metersPerPx)',()=>{
  // 200×200 px image, AP at the centre (100,100), r=100 px.
  // metersPerPx 0.1 → the AP radius is 10 m.
  const ap={fx:0.5,fy:0.5,r:100};

  test('free space matches FSPL(1m) + 10·n·log10(d) exactly',()=>{
    // 50 px = 5 m, 2.4 GHz (2437 MHz), logd n=2.2, default EIRP 20 dBm.
    const d=dbmAt({...ap,freq:'2.4 GHz only'},150,100,200,200,[],{metersPerPx:0.1});
    const pl=20*Math.log10(2437)-27.55 + 22*Math.log10(5);
    expect(d).toBeCloseTo(20-pl,6);
  });
  test('5 GHz reads ~7 dB weaker than 2.4 GHz at the same distance',()=>{
    const d24=dbmAt({...ap,freq:'2.4 GHz only'},150,100,200,200,[],{metersPerPx:0.1});
    const d5 =dbmAt({...ap,freq:'5 GHz only'},  150,100,200,200,[],{metersPerPx:0.1});
    expect(d24-d5).toBeCloseTo(20*Math.log10(5500/2437),4);
  });
  test('freqMhz override beats the band label',()=>{
    const viaLabel=dbmAt({...ap,freq:'5 GHz only'},150,100,200,200,[],{metersPerPx:0.1});
    const viaOverride=dbmAt({...ap,freq:'2.4 GHz only'},150,100,200,200,[],{metersPerPx:0.1,freqMhz:5500});
    expect(viaOverride).toBeCloseTo(viaLabel,6);
  });
  test('signal decays monotonically with distance',()=>{
    const near=dbmAt(ap,110,100,200,200,[],{metersPerPx:0.1});
    const far =dbmAt(ap,180,100,200,200,[],{metersPerPx:0.1});
    expect(near).toBeGreaterThan(far);
  });
  test('a wall subtracts exactly its material loss',()=>{
    const walls=[{x1:110,y1:0,x2:110,y2:200,material:'drywall'}];
    const open=dbmAt(ap,150,100,200,200,[],{metersPerPx:0.1});
    const blocked=dbmAt(ap,150,100,200,200,walls,{metersPerPx:0.1});
    expect(open-blocked).toBeCloseTo(3,6);
  });
  test('eirpDbm override shifts the reading 1:1',()=>{
    const base=dbmAt(ap,150,100,200,200,[],{metersPerPx:0.1});
    const hot =dbmAt(ap,150,100,200,200,[],{metersPerPx:0.1,eirpDbm:26});
    expect(hot-base).toBeCloseTo(6,6);
  });
  test('itu-indoor (n=3.0) decays faster than multi-wall (n=2.0)',()=>{
    const mw =dbmAt(ap,180,100,200,200,[],{metersPerPx:0.1,model:'multi-wall'});
    const itu=dbmAt(ap,180,100,200,200,[],{metersPerPx:0.1,model:'itu-indoor'});
    expect(itu).toBeLessThan(mw);
  });
  test('near-field is floored at 0.5 m (no +∞ at the AP)',()=>{
    const atAp=dbmAt(ap,100,100,200,200,[],{metersPerPx:0.1});
    expect(Number.isFinite(atAp)).toBe(true);
  });
  test('absent or zero metersPerPx falls back to the per-radius heuristic',()=>{
    const heuristic=dbmAt(ap,120,100,200,200,[]);
    expect(dbmAt(ap,120,100,200,200,[],{metersPerPx:0})).toBeCloseTo(heuristic,9);
    expect(dbmAt(ap,120,100,200,200,[],{metersPerPx:NaN})).toBeCloseTo(heuristic,9);
  });
  test('dbmAtThroughSlab physical: slab dB subtracted exactly',()=>{
    const direct=dbmAtThroughSlab(ap,140,100,200,200,0,1.0,'logd',0.1);
    const slabbed=dbmAtThroughSlab(ap,140,100,200,200,3,1.0,'logd',0.1);
    expect(direct-slabbed).toBeCloseTo(3,6);
    // And the direct value matches the free-space physical formula (5.5 GHz default).
    const pl=20*Math.log10(5500)-27.55 + 22*Math.log10(4);
    expect(direct).toBeCloseTo(20-pl,6);
  });
  test('sampleRoamingOverlap honours floor.scaleM without breaking shape',()=>{
    const floor={
      scaleM:50,
      APS:[{fx:0.4,fy:0.5,r:100,freq:'5 GHz only'},{fx:0.6,fy:0.5,r:100,freq:'5 GHz only'}],
      WALLS:[],
    };
    const res=sampleRoamingOverlap(floor,200,200);
    expect(res.total).toBeGreaterThan(0);
    expect(res.covered).toBeGreaterThanOrEqual(0);
    expect(res.covered).toBeLessThanOrEqual(res.total);
  });
});

describe('unplaced APs', () => {
  test('cover nothing instead of producing NaN', async () => {
    const { dbmAt, coveredThroughWalls, dbmAtThroughSlab } = await import('../files/src/geometry.js');
    for (const ap of [{ fx: 0.5, fy: 0.5 }, { fy: 0.5, r: 100 }, { fx: NaN, fy: 0.5, r: 100 }]) {
      expect(dbmAt(ap, 10, 10, 1000, 1000, [], {})).toBeNull();
      expect(coveredThroughWalls(ap, 10, 10, 1000, 1000, [])).toBe(false);
      expect(dbmAtThroughSlab(ap, 10, 10, 1000, 1000, 10)).toBeNull();
    }
    expect(dbmAt({ fx: 0.5, fy: 0.5, r: 300 }, 500, 520, 1000, 1000, [], {})).toBeGreaterThan(-100);
  });
});
