// Static catalogs used by the AP/SW/CAM dropdowns, the heatmap legend, the
// regulatory dropdown and the auto channel/Tx-power planner. Kept in their
// own module so app.js doesn't carry several hundred lines of catalog data.

import {WALL_MATERIALS, PROP_EXPONENT} from './geometry.js';

// AP models grouped by manufacturer. Rendered as <optgroup> in the model dropdown.
export const AP_MODEL_GROUPS=[
  {label:'Ubiquiti UniFi — WiFi 6', models:[
    'U6 Lite','U6 Pro','U6 Plus','U6 Mesh','U6 Long-Range',
    'U6 Enterprise','U6 Enterprise In-Wall','U6 Extender',
    'U6 IW','U6+',
  ]},
  {label:'Ubiquiti UniFi — WiFi 7', models:[
    'U7 Pro','U7 Pro Max','U7 Pro Wall','U7 Pro XG',
    'U7 Outdoor','U7 Lite','U7 IW','U7 In-Wall',
    'E7','U7 Enterprise','U7 Enterprise Campus',
  ]},
  {label:'Ubiquiti UniFi — WiFi 5 (legacy)', models:[
    'UAP-AC-Pro','UAP-AC-Lite','UAP-AC-Mesh','UAP-AC-Mesh-Pro',
    'UAP-AC-HD','UAP-AC-SHD','UAP-nanoHD',
    'UAP-IW-HD','UAP-IW','UAP-BeaconHD',
    'UAP-AC-M','UAP-AC-M-Pro',
  ]},
  {label:'MikroTik — WiFi 6 / ax', models:[
    'cAP ax','cAP-XL ax','hAP ax²','hAP ax³','hAP ax lite',
    'wAP ax','wAP ax R','Chateau ax',
  ]},
  {label:'MikroTik — WiFi 5 / ac', models:[
    'cAP ac','cAP ac XL','hAP ac','hAP ac²','hAP ac³','hAP ac lite',
    'wAP ac','wAP-60G','mAP','mAP lite','Audience',
    'RBwAPGR-5HacD2HnD','Chateau LTE6 ac',
  ]},
  {label:'Aruba / HPE — WiFi 6 / 6E', models:[
    'AP-505','AP-515','AP-535','AP-555',
    'AP-635','AP-655','AP-577 (outdoor)','AP-585 (outdoor)',
    'AP-303H','AP-318 (outdoor)','Instant On AP22','Instant On AP25',
  ]},
  {label:'Aruba / HPE — WiFi 7', models:[
    'AP-734','AP-735','AP-755','AP-770 (outdoor)','Instant On AP32',
  ]},
  {label:'Cisco Catalyst — WiFi 6 / 6E', models:[
    'C9105AXI','C9115AXI','C9120AXI','C9130AXI',
    'C9136I','C9162I','C9164I','C9166I','C9166D1',
    'C9124AXI (outdoor)','C9130AXE (outdoor)',
  ]},
  {label:'Cisco Catalyst — WiFi 7', models:[
    'CW9172I','CW9176I','CW9176D1','CW9178I','CW9182I (outdoor)',
  ]},
  {label:'Cisco Meraki', models:[
    'MR36','MR44','MR46','MR46E','MR56','MR57',
    'MR76 (outdoor)','MR78 (outdoor)','MR86 (outdoor)',
    'CW9162 (cloud)','CW9164 (cloud)','CW9166 (cloud)',
  ]},
  {label:'CommScope Ruckus', models:[
    'R350','R550','R650','R750','R760','R770',
    'R850','R950','T350c (outdoor)','T350d (outdoor)',
    'T750 (outdoor)','T780 (outdoor)',
  ]},
  {label:'Cambium Networks', models:[
    'XV2-2','XV2-21X','XV2-22H','XV2-23T (outdoor)',
    'XV3-8','XE3-4','XE5-8','XV-4 (outdoor)',
    'cnPilot e410','cnPilot e600','ePMP 6 GHz BH',
  ]},
  {label:'TP-Link Omada', models:[
    'EAP225','EAP245','EAP620 HD','EAP650','EAP670','EAP690E HD',
    'EAP650-Outdoor','EAP610-Outdoor','EAP683 LR',
    'EAP772','EAP780 (outdoor)','Omada BE9300','Omada BE11000',
  ]},
  {label:'EnGenius', models:[
    'ECW215','ECW220','ECW230','ECW230S','ECW260 (outdoor)',
    'ECW336','ECW526','ECW536','ECW220S','EWS357AP-FIT',
  ]},
  {label:'Extreme Networks', models:[
    'AP305C','AP305CX','AP410C','AP460C','AP510C','AP560h (outdoor)',
    'AP3000','AP4000','AP5010','AP5050U (outdoor)',
  ]},
  {label:'Other', models:['Custom/Other']},
];
export const MODELS=AP_MODEL_GROUPS.flatMap(g=>g.models);

// Typical coverage radius in metres (conservative indoor estimate) for each model.
// Used as a sensible default when placing an AP and when the user changes model.
export const AP_RANGE_M={
  // UniFi WiFi 6
  'U6 Lite':18,'U6 Pro':25,'U6 Plus':22,'U6 Mesh':20,'U6 Long-Range':40,
  'U6 Enterprise':30,'U6 Enterprise In-Wall':20,'U6 Extender':15,'U6 IW':18,'U6+':20,
  // UniFi WiFi 7
  'U7 Pro':28,'U7 Pro Max':32,'U7 Pro Wall':22,'U7 Pro XG':28,
  'U7 Outdoor':50,'U7 Lite':20,'U7 IW':20,'U7 In-Wall':20,
  'E7':32,'U7 Enterprise':35,'U7 Enterprise Campus':40,
  // UniFi WiFi 5
  'UAP-AC-Pro':22,'UAP-AC-Lite':16,'UAP-AC-Mesh':18,'UAP-AC-Mesh-Pro':30,
  'UAP-AC-HD':30,'UAP-AC-SHD':30,'UAP-nanoHD':20,
  'UAP-IW-HD':18,'UAP-IW':15,'UAP-BeaconHD':15,'UAP-AC-M':22,'UAP-AC-M-Pro':30,
  // MikroTik WiFi 6 / ax
  'cAP ax':28,'cAP-XL ax':35,'hAP ax²':20,'hAP ax³':30,'hAP ax lite':15,
  'wAP ax':45,'wAP ax R':40,'Chateau ax':25,
  // MikroTik WiFi 5 / ac
  'cAP ac':22,'cAP ac XL':28,'hAP ac':18,'hAP ac²':18,'hAP ac³':22,'hAP ac lite':14,
  'wAP ac':35,'wAP-60G':20,'mAP':12,'mAP lite':10,'Audience':22,
  'RBwAPGR-5HacD2HnD':30,'Chateau LTE6 ac':22,
  // Aruba / HPE
  'AP-505':25,'AP-515':28,'AP-535':32,'AP-555':35,
  'AP-635':30,'AP-655':35,'AP-577 (outdoor)':55,'AP-585 (outdoor)':60,
  'AP-303H':20,'AP-318 (outdoor)':45,'Instant On AP22':22,'Instant On AP25':28,
  'AP-734':30,'AP-735':35,'AP-755':40,'AP-770 (outdoor)':60,'Instant On AP32':30,
  // Cisco Catalyst
  'C9105AXI':22,'C9115AXI':25,'C9120AXI':28,'C9130AXI':30,
  'C9136I':35,'C9162I':28,'C9164I':30,'C9166I':32,'C9166D1':32,
  'C9124AXI (outdoor)':55,'C9130AXE (outdoor)':60,
  'CW9172I':30,'CW9176I':35,'CW9176D1':35,'CW9178I':38,'CW9182I (outdoor)':60,
  // Meraki
  'MR36':22,'MR44':25,'MR46':28,'MR46E':30,'MR56':32,'MR57':35,
  'MR76 (outdoor)':55,'MR78 (outdoor)':60,'MR86 (outdoor)':60,
  'CW9162 (cloud)':28,'CW9164 (cloud)':32,'CW9166 (cloud)':35,
  // Ruckus
  'R350':22,'R550':25,'R650':28,'R750':32,'R760':35,'R770':35,
  'R850':35,'R950':40,'T350c (outdoor)':55,'T350d (outdoor)':60,
  'T750 (outdoor)':65,'T780 (outdoor)':70,
  // Cambium
  'XV2-2':22,'XV2-21X':28,'XV2-22H':25,'XV2-23T (outdoor)':55,
  'XV3-8':32,'XE3-4':30,'XE5-8':35,'XV-4 (outdoor)':60,
  'cnPilot e410':22,'cnPilot e600':28,'ePMP 6 GHz BH':30,
  // TP-Link Omada
  'EAP225':18,'EAP245':22,'EAP620 HD':25,'EAP650':28,'EAP670':30,'EAP690E HD':32,
  'EAP650-Outdoor':50,'EAP610-Outdoor':45,'EAP683 LR':35,
  'EAP772':32,'EAP780 (outdoor)':55,'Omada BE9300':35,'Omada BE11000':40,
  // EnGenius
  'ECW215':22,'ECW220':25,'ECW230':28,'ECW230S':30,'ECW260 (outdoor)':55,
  'ECW336':32,'ECW526':32,'ECW536':35,'ECW220S':25,'EWS357AP-FIT':28,
  // Extreme
  'AP305C':22,'AP305CX':25,'AP410C':28,'AP460C':30,'AP510C':32,
  'AP560h (outdoor)':55,'AP3000':30,'AP4000':35,'AP5010':40,'AP5050U (outdoor)':60,
  // Fallback
  'Custom/Other':25,
};

// Typical antenna gain (dBi). Used to compute EIRP. Outdoor & long-range APs
// trend higher; indoor omnis ~3 dBi; in-wall ~2.5; PTPs much higher.
export const AP_ANTENNA_GAIN_DBI={
  // UniFi
  'U6 Lite':3,'U6 Pro':3,'U6 Plus':3,'U6 Mesh':3,'U6 Long-Range':6,
  'U6 Enterprise':5,'U6 Enterprise In-Wall':2.5,'U6 Extender':3,'U6 IW':2.5,'U6+':3,
  'U7 Pro':4,'U7 Pro Max':5,'U7 Pro Wall':3,'U7 Pro XG':5,
  'U7 Outdoor':6,'U7 Lite':3,'U7 IW':2.5,'U7 In-Wall':2.5,
  'E7':5,'U7 Enterprise':5,'U7 Enterprise Campus':6,
  'UAP-AC-Pro':3,'UAP-AC-Lite':3,'UAP-AC-Mesh':3,'UAP-AC-Mesh-Pro':8,
  'UAP-AC-HD':4,'UAP-AC-SHD':4,'UAP-nanoHD':3,
  'UAP-IW-HD':2.5,'UAP-IW':2.5,'UAP-BeaconHD':3,'UAP-AC-M':3,'UAP-AC-M-Pro':6,
  // MikroTik
  'cAP ax':4,'cAP-XL ax':6,'hAP ax²':2.5,'hAP ax³':4,'hAP ax lite':2,
  'wAP ax':5,'wAP ax R':5,'Chateau ax':4,
  'cAP ac':2,'cAP ac XL':4,'hAP ac':2.5,'hAP ac²':2.5,'hAP ac³':3,'hAP ac lite':2,
  'wAP ac':5,'wAP-60G':9,'mAP':1.5,'mAP lite':1.5,'Audience':3,
  'RBwAPGR-5HacD2HnD':6,'Chateau LTE6 ac':4,
  // Aruba / HPE
  'AP-505':4,'AP-515':4,'AP-535':5,'AP-555':6,
  'AP-635':5,'AP-655':5,'AP-577 (outdoor)':7,'AP-585 (outdoor)':8,
  'AP-303H':2.5,'AP-318 (outdoor)':6,'Instant On AP22':3,'Instant On AP25':3,
  'AP-734':5,'AP-735':5,'AP-755':6,'AP-770 (outdoor)':7,'Instant On AP32':4,
  // Cisco Catalyst
  'C9105AXI':3,'C9115AXI':4,'C9120AXI':4,'C9130AXI':5,
  'C9136I':5,'C9162I':4,'C9164I':5,'C9166I':5,'C9166D1':5,
  'C9124AXI (outdoor)':6,'C9130AXE (outdoor)':7,
  'CW9172I':5,'CW9176I':5,'CW9176D1':5,'CW9178I':5,'CW9182I (outdoor)':7,
  // Meraki
  'MR36':3,'MR44':3,'MR46':4,'MR46E':4,'MR56':5,'MR57':5,
  'MR76 (outdoor)':6,'MR78 (outdoor)':6,'MR86 (outdoor)':7,
  'CW9162 (cloud)':4,'CW9164 (cloud)':5,'CW9166 (cloud)':5,
  // Ruckus
  'R350':3,'R550':3,'R650':4,'R750':4,'R760':4,'R770':4,
  'R850':5,'R950':5,'T350c (outdoor)':6,'T350d (outdoor)':6,
  'T750 (outdoor)':7,'T780 (outdoor)':7,
  // Cambium
  'XV2-2':3,'XV2-21X':4,'XV2-22H':3,'XV2-23T (outdoor)':6,
  'XV3-8':5,'XE3-4':5,'XE5-8':6,'XV-4 (outdoor)':7,
  'cnPilot e410':3,'cnPilot e600':4,'ePMP 6 GHz BH':10,
  // TP-Link Omada
  'EAP225':3,'EAP245':3,'EAP620 HD':3,'EAP650':4,'EAP670':4,'EAP690E HD':5,
  'EAP650-Outdoor':5,'EAP610-Outdoor':5,'EAP683 LR':6,
  'EAP772':5,'EAP780 (outdoor)':6,'Omada BE9300':5,'Omada BE11000':6,
  // EnGenius
  'ECW215':3,'ECW220':3,'ECW230':4,'ECW230S':4,'ECW260 (outdoor)':6,
  'ECW336':5,'ECW526':5,'ECW536':5,'ECW220S':3,'EWS357AP-FIT':4,
  // Extreme
  'AP305C':3,'AP305CX':4,'AP410C':4,'AP460C':5,'AP510C':5,
  'AP560h (outdoor)':6,'AP3000':5,'AP4000':5,'AP5010':6,'AP5050U (outdoor)':7,
  // Fallback
  'Custom/Other':4,
};

// Switch / router models — grouped the same way as APs so the dropdown code
// can render either list identically.
export const SW_MODEL_GROUPS=[
  {label:'Ubiquiti UniFi — Switches', models:[
    'USW-Flex-Mini','USW-Flex','USW-Flex-Utility',
    'USW-Lite-8-PoE','USW-Lite-16-PoE',
    'USW-16','USW-16-PoE',
    'USW-24','USW-24-PoE',
    'USW-48','USW-48-PoE',
    'USW-Pro-8-PoE','USW-Pro-24','USW-Pro-24-PoE',
    'USW-Pro-48','USW-Pro-48-PoE',
    'USW-Pro-Max-16','USW-Pro-Max-24','USW-Pro-Max-48',
    'USW-Pro-Max-24-PoE','USW-Pro-Max-48-PoE',
    'USW-Aggregation','USW-Pro-Aggregation',
    'USW-EnterpriseXG-24','USW-Enterprise-24-PoE','USW-Enterprise-48-PoE','USW-Enterprise-8-PoE',
    'USW-Industrial','USW-Mission-Critical',
  ]},
  {label:'Ubiquiti UniFi — Routers & Gateways', models:[
    'UDM','UDM-Pro','UDM-SE','UDM-Pro-Max',
    'UXG-Lite','UXG-Pro','UXG-Max','UXG-Enterprise',
    'UCG-Fiber','UCG-Max','UCG-Ultra',
    'USG','USG-Pro-4','USG-3P',
    'Dream Router','Dream Router 7','Dream Machine',
    'Cloud Gateway Fiber','Cloud Gateway Max','Cloud Gateway Ultra',
  ]},
  {label:'MikroTik — Routers (Home / SMB)', models:[
    'hEX (RB750Gr4)','hEX S (RB760iGS)','hEX refresh',
    'hAP mini','hAP lite','hAP','hAP ac lite','hAP ac²','hAP ac³',
    'hAP ax lite','hAP ax²','hAP ax³',
    'RB4011iGS+RM','RB4011iGS+5HacQ2HnD-IN',
    'RB5009UG+S+IN','RB5009UPr+S+IN','RB5009UG+S+IN PoE',
    'RB3011UiAS-RM','RB2011UiAS-RM','RB2011iL-RM','RB2011iL-IN',
  ]},
  {label:'MikroTik — Routers (ISP / Enterprise)', models:[
    'L009UiGS-RM','L009UiGS-2HaxD-IN','L009UiGS-RM+Rack',
    'CCR1009-7G-1C-1S+','CCR1016-12G','CCR1036-12G-4S','CCR1036-8G-2S+',
    'CCR1072-1G-8S+',
    'CCR2004-1G-12S+2XS','CCR2004-16G-2S+','CCR2004-1G-2XS-PCIe',
    'CCR2116-12G-4S+','CCR2216-1G-12XS-2XQ',
  ]},
  {label:'MikroTik — Switches (Smart)', models:[
    'CSS326-24G-2S+RM','CSS610-8G-2S+IN','CSS318-16G-2S+IN','CSS318-16P-4S+RM',
  ]},
  {label:'MikroTik — Switches (CRS3xx — Managed)', models:[
    'CRS305-1G-4S+IN',
    'CRS309-1G-8S+IN','CRS309-1G-8S+IN Rackmount',
    'CRS310-1G-5S-4S+IN','CRS310-1G-5S-4S+OUT','CRS310-8G+2S+IN',
    'CRS312-4C+8XG-RM',
    'CRS317-1G-16S+RM',
    'CRS318-1Fi-15Fr-2S','CRS318-16P-2S+OUT',
    'CRS326-24G-2S+RM','CRS326-24G-2S+IN','CRS326-4C+20G+2Q+RM','CRS326-24S+2Q+RM',
    'CRS328-24P-4S+RM','CRS328-4C-20S-4S+RM',
    'CRS354-48G-4S+2Q+RM','CRS354-48P-4S+2Q+RM',
  ]},
  {label:'MikroTik — Switches (CRS5xx — High End)', models:[
    'CRS504-4XQ-IN','CRS510-8XS-2XQ-IN','CRS518-16XS-2XQ-RM','CRS520-4XS-16XQ-RM',
  ]},
  {label:'Aruba / HPE — Switches', models:[
    'Aruba 2530-8G-PoE','Aruba 2540-24G-PoE','Aruba 2930F-24G-PoE',
    'Aruba 2930M-24G-PoE','Aruba 6100-24G-PoE','Aruba 6200F-24G-PoE',
    'Aruba 6300M-24G-PoE','Aruba CX 8320','Aruba CX 8325','Aruba CX 8360',
    'Aruba Instant On 1930 24P','Instant On 1960 24P',
  ]},
  {label:'Cisco Catalyst — Switches', models:[
    'C1000-24P','C1300-24P','C9200-24P','C9200L-24P-4G',
    'C9300-24P','C9300X-24Y','C9300L-24P','C9400 Sup-1',
    'Meraki MS125-24P','Meraki MS225-24P','Meraki MS250-48FP','Meraki MS355-24X',
  ]},
  {label:'TP-Link Omada — Switches', models:[
    'TL-SG2008P','TL-SG2210MP','TL-SG3210XHP-M2','TL-SG3428MP',
    'TL-SG3452XP','TL-SG3452XMP','OmadaSX3008F','SX6632YF',
  ]},
  {label:'Netgear Pro / AV-line', models:[
    'GS308P','GS108Tv3','GS324T','GS750E',
    'M4250-26G4XF-PoE+','M4350-24G4XF','M4500-32C','XSM4324CV',
  ]},
  {label:'Other', models:['Custom/Other']},
];
export const SW_MODELS=SW_MODEL_GROUPS.flatMap(g=>g.models);

// Default PoE budget hint (W). Used when the user picks a known model so the
// budget field starts non-zero; user can override per switch.
export const SW_POE_BUDGET_W={
  'USW-Lite-8-PoE':52,'USW-Lite-16-PoE':45,'USW-16-PoE':42,'USW-24-PoE':95,
  'USW-48-PoE':195,'USW-Pro-8-PoE':150,'USW-Pro-24-PoE':400,'USW-Pro-48-PoE':600,
  'USW-Pro-Max-24-PoE':400,'USW-Pro-Max-48-PoE':720,
  'USW-Enterprise-8-PoE':150,'USW-Enterprise-24-PoE':400,'USW-Enterprise-48-PoE':720,
  'UDM-Pro':0,'UDM-SE':180,
  'CSS318-16P-4S+RM':350,'CRS318-16P-2S+OUT':250,
  'CRS328-24P-4S+RM':500,'CRS354-48P-4S+2Q+RM':700,
  'Aruba 2530-8G-PoE':67,'Aruba 2540-24G-PoE':195,'Aruba 2930F-24G-PoE':370,
  'Aruba 2930M-24G-PoE':800,'Aruba 6100-24G-PoE':370,'Aruba 6200F-24G-PoE':370,
  'Aruba 6300M-24G-PoE':1440,
  'C1000-24P':195,'C1300-24P':375,'C9200-24P':370,'C9200L-24P-4G':370,
  'C9300-24P':445,'C9300X-24Y':1100,'C9300L-24P':505,
  'Meraki MS125-24P':370,'Meraki MS225-24P':370,'Meraki MS250-48FP':740,'Meraki MS355-24X':800,
  'TL-SG2008P':62,'TL-SG2210MP':150,'TL-SG3210XHP-M2':320,'TL-SG3428MP':384,
  'TL-SG3452XP':500,'TL-SG3452XMP':500,
  'GS308P':83,'GS108Tv3':123,'GS324T':195,'GS750E':380,
  'M4250-26G4XF-PoE+':480,'M4350-24G4XF':550,
  'Aruba Instant On 1930 24P':195,'Instant On 1960 24P':370,
  'USW-Industrial':450,
};

// Total access-port count per switch model — used for the over-subscription
// check (assigned devices vs available ports). Only models we're confident
// about are listed; swPortCount() returns null for anything else so the check
// is skipped rather than warning on a guess.
export const SW_PORTS={
  // UniFi switches
  'USW-Flex-Mini':5,'USW-Flex':5,'USW-Flex-Utility':5,
  'USW-Lite-8-PoE':8,'USW-Lite-16-PoE':16,
  'USW-16':16,'USW-16-PoE':16,'USW-24':24,'USW-24-PoE':24,'USW-48':48,'USW-48-PoE':48,
  'USW-Pro-8-PoE':8,'USW-Pro-24':24,'USW-Pro-24-PoE':24,'USW-Pro-48':48,'USW-Pro-48-PoE':48,
  'USW-Pro-Max-16':16,'USW-Pro-Max-24':24,'USW-Pro-Max-48':48,
  'USW-Pro-Max-24-PoE':24,'USW-Pro-Max-48-PoE':48,
  'USW-EnterpriseXG-24':24,'USW-Enterprise-8-PoE':8,'USW-Enterprise-24-PoE':24,'USW-Enterprise-48-PoE':48,
  'USW-Aggregation':8,'USW-Pro-Aggregation':28,'USW-Industrial':10,
  // UniFi gateways (LAN ports)
  'UDM':4,'UDM-Pro':8,'UDM-SE':8,'UDM-Pro-Max':8,
  // MikroTik
  'CSS326-24G-2S+RM':24,'CSS610-8G-2S+IN':8,'CSS318-16G-2S+IN':16,'CSS318-16P-4S+RM':16,
  'CRS305-1G-4S+IN':4,'CRS309-1G-8S+IN':8,'CRS310-8G+2S+IN':8,'CRS312-4C+8XG-RM':8,
  'CRS317-1G-16S+RM':16,'CRS318-16P-2S+OUT':16,'CRS326-24G-2S+RM':24,'CRS326-24G-2S+IN':24,
  'CRS328-24P-4S+RM':24,'CRS354-48G-4S+2Q+RM':48,'CRS354-48P-4S+2Q+RM':48,
  // Aruba / HPE
  'Aruba 2530-8G-PoE':8,'Aruba 2540-24G-PoE':24,'Aruba 2930F-24G-PoE':24,
  'Aruba 2930M-24G-PoE':24,'Aruba 6100-24G-PoE':24,'Aruba 6200F-24G-PoE':24,'Aruba 6300M-24G-PoE':24,
  'Aruba Instant On 1930 24P':24,'Instant On 1960 24P':24,
  // Cisco
  'C1000-24P':24,'C1300-24P':24,'C9200-24P':24,'C9200L-24P-4G':24,
  'C9300-24P':24,'C9300X-24Y':24,'C9300L-24P':24,
  'Meraki MS125-24P':24,'Meraki MS225-24P':24,'Meraki MS250-48FP':48,'Meraki MS355-24X':24,
  // TP-Link Omada
  'TL-SG2008P':8,'TL-SG2210MP':10,'TL-SG3210XHP-M2':8,'TL-SG3428MP':24,
  'TL-SG3452XP':48,'TL-SG3452XMP':48,
  // Netgear
  'GS308P':8,'GS108Tv3':8,'GS324T':24,'GS750E':48,
  'M4250-26G4XF-PoE+':24,'M4350-24G4XF':24,
};
// Access ports for a model; null when unknown (skip the check). UniFi USW-*
// names end in their port count, so we parse those as a fallback.
export function swPortCount(model){
  if(!model)return null;
  if(model in SW_PORTS)return SW_PORTS[model];
  const m=/^USW\b.*?(\d+)(?:-PoE)?$/i.exec(model);
  return m?parseInt(m[1],10):null;
}

// Highest PoE standard a switch delivers per port:
//   af = 802.3af (≤15.4 W) · at = 802.3at/PoE+ (≤30 W) · bt = 802.3bt (≤90 W)
// Only exceptions are listed; swPoeClass() defaults any PoE-capable switch to
// 'at', which fits the large majority of access switches.
export const SW_POE_CLASS={
  'USW-Pro-24-PoE':'bt','USW-Pro-48-PoE':'bt',
  'USW-Pro-Max-24-PoE':'bt','USW-Pro-Max-48-PoE':'bt',
  'USW-Enterprise-8-PoE':'bt','USW-Enterprise-24-PoE':'bt','USW-Enterprise-48-PoE':'bt',
  'USW-Industrial':'bt',
  'Aruba 6300M-24G-PoE':'bt',
  'C9300-24P':'bt','C9300X-24Y':'bt','C9300L-24P':'bt',
  'Meraki MS250-48FP':'bt','Meraki MS355-24X':'bt',
  'TL-SG3210XHP-M2':'bt','TL-SG3428MP':'bt','TL-SG3452XMP':'bt',
  'M4250-26G4XF-PoE+':'bt','M4350-24G4XF':'bt',
};
export const POE_CLASS_RANK={af:1,at:2,bt:3};
// Lowest PoE standard that can supply a given wattage (null for no draw).
export function poeClassForWatts(w){
  if(!w||w<=0)return null;
  if(w<=15.4)return 'af';
  if(w<=30)return 'at';
  return 'bt';
}
// What a switch model can deliver per port; null = no PoE. `budget` lets a
// custom model with a user-set PoE budget still count as PoE-capable.
export function swPoeClass(model,budget){
  if(model && model in SW_POE_CLASS)return SW_POE_CLASS[model];
  if((budget||SW_POE_BUDGET_W[model]||0)>0)return 'at';
  return null;
}

export const WALL_MATERIAL_KEYS=Object.keys(WALL_MATERIALS);

// AP antenna patterns. `arc` is the half-angle in degrees the AP radiates
// through; `omni` covers the full 360°.
export const AP_PATTERNS={
  omni:       {label:'Omni (default)',       arc:180},
  ceiling:    {label:'Ceiling-mount (down)', arc:180},
  'wall':     {label:'Wall-mount',           arc:75},
  'sector-90':{label:'Sector 90°',           arc:45},
  'sector-60':{label:'Sector 60°',           arc:30},
  'sector-30':{label:'Sector 30°',           arc:15},
};
export const AP_PATTERN_KEYS=Object.keys(AP_PATTERNS);

// Typical PoE draw in watts at full load. Used by the PoE-budget calculator.
// Conservative estimates from vendor datasheets; the user can edit per switch.
export const AP_POE_W={
  // UniFi WiFi 6
  'U6 Lite':12,'U6 Pro':17,'U6 Plus':14,'U6 Mesh':12,'U6 Long-Range':15,
  'U6 Enterprise':25,'U6 Enterprise In-Wall':22,'U6 Extender':10,
  'U6 IW':15,'U6+':12,
  // UniFi WiFi 7
  'U7 Pro':23,'U7 Pro Max':30,'U7 Pro Wall':18,'U7 Pro XG':25,
  'U7 Outdoor':22,'U7 Lite':13,'U7 IW':18,'U7 In-Wall':18,
  'E7':30,'U7 Enterprise':30,'U7 Enterprise Campus':35,
  // UniFi WiFi 5
  'UAP-AC-Pro':9,'UAP-AC-Lite':7,'UAP-AC-Mesh':9,'UAP-AC-Mesh-Pro':9,
  'UAP-AC-HD':17,'UAP-AC-SHD':25,'UAP-nanoHD':11,
  'UAP-IW-HD':17,'UAP-IW':9,'UAP-BeaconHD':9,
  'UAP-AC-M':8,'UAP-AC-M-Pro':9,
  // MikroTik
  'cAP ax':10,'cAP-XL ax':14,'hAP ax²':17,'hAP ax³':17,'hAP ax lite':10,
  'wAP ax':12,'wAP ax R':14,'Chateau ax':18,
  'cAP ac':6,'cAP ac XL':12,'hAP ac':12,'hAP ac²':14,'hAP ac³':14,'hAP ac lite':6,
  'wAP ac':5,'wAP-60G':12,'mAP':5,'mAP lite':2,'Audience':14,
  'RBwAPGR-5HacD2HnD':12,'Chateau LTE6 ac':18,
  // Aruba / HPE
  'AP-505':14,'AP-515':18,'AP-535':25,'AP-555':35,
  'AP-635':25,'AP-655':35,'AP-577 (outdoor)':30,'AP-585 (outdoor)':35,
  'AP-303H':14,'AP-318 (outdoor)':25,'Instant On AP22':10,'Instant On AP25':15,
  'AP-734':28,'AP-735':35,'AP-755':45,'AP-770 (outdoor)':45,'Instant On AP32':25,
  // Cisco Catalyst
  'C9105AXI':12,'C9115AXI':16,'C9120AXI':20,'C9130AXI':25,
  'C9136I':30,'C9162I':25,'C9164I':25,'C9166I':30,'C9166D1':30,
  'C9124AXI (outdoor)':30,'C9130AXE (outdoor)':30,
  'CW9172I':25,'CW9176I':30,'CW9176D1':30,'CW9178I':35,'CW9182I (outdoor)':35,
  // Meraki
  'MR36':14,'MR44':17,'MR46':22,'MR46E':24,'MR56':30,'MR57':35,
  'MR76 (outdoor)':25,'MR78 (outdoor)':30,'MR86 (outdoor)':30,
  'CW9162 (cloud)':22,'CW9164 (cloud)':25,'CW9166 (cloud)':30,
  // Ruckus
  'R350':12,'R550':16,'R650':20,'R750':25,'R760':30,'R770':30,
  'R850':30,'R950':35,'T350c (outdoor)':22,'T350d (outdoor)':25,
  'T750 (outdoor)':30,'T780 (outdoor)':35,
  // Cambium
  'XV2-2':14,'XV2-21X':20,'XV2-22H':22,'XV2-23T (outdoor)':30,
  'XV3-8':30,'XE3-4':25,'XE5-8':35,'XV-4 (outdoor)':40,
  'cnPilot e410':14,'cnPilot e600':18,'ePMP 6 GHz BH':25,
  // TP-Link Omada
  'EAP225':9,'EAP245':12,'EAP620 HD':15,'EAP650':14,'EAP670':17,'EAP690E HD':30,
  'EAP650-Outdoor':17,'EAP610-Outdoor':14,'EAP683 LR':17,
  'EAP772':28,'EAP780 (outdoor)':30,'Omada BE9300':25,'Omada BE11000':30,
  // EnGenius
  'ECW215':14,'ECW220':17,'ECW230':22,'ECW230S':25,'ECW260 (outdoor)':25,
  'ECW336':28,'ECW526':28,'ECW536':30,'ECW220S':17,'EWS357AP-FIT':17,
  // Extreme
  'AP305C':14,'AP305CX':18,'AP410C':22,'AP460C':25,'AP510C':28,
  'AP560h (outdoor)':25,'AP3000':28,'AP4000':30,'AP5010':35,'AP5050U (outdoor)':35,
  // Fallback
  'Custom/Other':15,
};

// Camera model catalog. Grouped like the AP catalog so the dropdown is consistent.
export const CAM_MODEL_GROUPS=[
  {label:'Ubiquiti UniFi Protect — G5 (current)', models:[
    'G5 Pro','G5 Bullet','G5 Dome','G5 Flex','G5 Turret Ultra',
    'G5 PTZ','G5 Dome Ultra','G5 Bullet Ultra',
  ]},
  {label:'Ubiquiti UniFi Protect — AI series', models:[
    'AI Pro','AI 360','AI DSLR','AI Theta','AI Bullet','AI LPR',
  ]},
  {label:'Ubiquiti UniFi Protect — G4 (legacy)', models:[
    'G4 Pro','G4 Bullet','G4 Dome','G4 PTZ','G4 Doorbell','G4 Doorbell Pro',
    'G4 Instant',
  ]},
  {label:'Ubiquiti UniFi Protect — G3 (very legacy)', models:[
    'G3 Pro','G3 Bullet','G3 Dome','G3 Flex','G3 Instant','G3 Micro',
  ]},
  {label:'Hikvision', models:[
    'DS-2CD2143G2-I (Dome 4MP)','DS-2CD2T46G2-2I (Bullet 4MP)',
    'DS-2CD2386G2-IU (8MP)','DS-2DE4225IW-DE (PTZ)','Generic Hikvision',
  ]},
  {label:'Dahua', models:[
    'IPC-HDW3441T-AS (Dome 4MP)','IPC-HFW3441T-AS (Bullet 4MP)',
    'IPC-HDBW5442H (5MP)','SD49225XA-HNR (PTZ)','Generic Dahua',
  ]},
  {label:'Reolink', models:[
    'RLC-410W','RLC-810A 2.8mm','RLC-811A','RLC-820A','RLC-823A','RLC-823S2',
    'RLC-833A','RLC-1212A','RLC-1224A','Duo 2 PoE','Duo 3 PoE','TrackMix PoE','Argus 4 Pro',
  ]},
  {label:'Axis', models:[
    'M3045-V','M3046-V','M3057-PLVE','P3245-LV','Q6125-LE (PTZ)','Generic Axis',
  ]},
  {label:'Bosch', models:[
    'FLEXIDOME IP starlight 8000i','DINION IP starlight 7100i',
    'AUTODOME IP starlight 5100i (PTZ)','Generic Bosch',
  ]},
  {label:'Vivotek', models:[
    'IB9387-HT','FD9389-EHTV','SD9384-EHL (PTZ)','Generic Vivotek',
  ]},
  {label:'Other', models:['Custom/Other']},
];
export const CAM_MODELS=CAM_MODEL_GROUPS.flatMap(g=>g.models);

// Typical specs per camera model. `fov` is horizontal field of view in
// degrees, `range` is effective night-vision range in metres (used as
// the default cone length on the map). Users can override either.
export const CAM_SPECS={
  // UniFi G5 — current gen
  'G5 Pro':           {fov:96, range:30,  res:'4K',   poeW:7},
  'G5 Bullet':        {fov:103,range:25,  res:'4MP',  poeW:5},
  'G5 Dome':          {fov:102,range:15,  res:'4MP',  poeW:5},
  'G5 Flex':          {fov:115,range:8,   res:'4MP',  poeW:5},
  'G5 Turret Ultra':  {fov:100,range:30,  res:'4MP',  poeW:5},
  'G5 PTZ':           {fov:75, range:80,  res:'4K',   poeW:30},
  'G5 Dome Ultra':    {fov:115,range:20,  res:'4MP',  poeW:6},
  'G5 Bullet Ultra':  {fov:115,range:30,  res:'4MP',  poeW:6},
  // UniFi AI
  'AI Pro':           {fov:110,range:35,  res:'4K',   poeW:13},
  'AI 360':           {fov:360,range:15,  res:'5MP',  poeW:9},
  'AI DSLR':          {fov:80, range:45,  res:'8MP',  poeW:13},
  'AI Theta':         {fov:360,range:20,  res:'5MP',  poeW:13},
  'AI Bullet':        {fov:110,range:35,  res:'4K',   poeW:13},
  'AI LPR':           {fov:50, range:30,  res:'4K',   poeW:13},
  // UniFi G4
  'G4 Pro':           {fov:70, range:30,  res:'4K',   poeW:8},
  'G4 Bullet':        {fov:100,range:25,  res:'4MP',  poeW:7},
  'G4 Dome':          {fov:100,range:15,  res:'4MP',  poeW:7},
  'G4 PTZ':           {fov:75, range:50,  res:'4K',   poeW:30},
  'G4 Doorbell':      {fov:160,range:10,  res:'2MP',  poeW:7},
  'G4 Doorbell Pro':  {fov:150,range:10,  res:'5MP',  poeW:7},
  'G4 Instant':       {fov:115,range:8,   res:'2MP',  poeW:0},
  // UniFi G3
  'G3 Pro':           {fov:85, range:25,  res:'1080p',poeW:8},
  'G3 Bullet':        {fov:84, range:25,  res:'1080p',poeW:8},
  'G3 Dome':          {fov:115,range:10,  res:'1080p',poeW:8},
  'G3 Flex':          {fov:115,range:8,   res:'1080p',poeW:5},
  'G3 Instant':       {fov:115,range:5,   res:'1080p',poeW:0},
  'G3 Micro':         {fov:115,range:5,   res:'1080p',poeW:0},
  // Hikvision
  'DS-2CD2143G2-I (Dome 4MP)':       {fov:103,range:30,res:'4MP',poeW:6},
  'DS-2CD2T46G2-2I (Bullet 4MP)':    {fov:103,range:60,res:'4MP',poeW:7},
  'DS-2CD2386G2-IU (8MP)':           {fov:102,range:30,res:'8MP',poeW:8},
  'DS-2DE4225IW-DE (PTZ)':           {fov:60, range:100,res:'2MP',poeW:18},
  'Generic Hikvision':               {fov:90, range:30,res:'4MP',poeW:8},
  // Dahua
  'IPC-HDW3441T-AS (Dome 4MP)':      {fov:101,range:30,res:'4MP',poeW:6},
  'IPC-HFW3441T-AS (Bullet 4MP)':    {fov:101,range:50,res:'4MP',poeW:7},
  'IPC-HDBW5442H (5MP)':             {fov:96, range:30,res:'5MP',poeW:7},
  'SD49225XA-HNR (PTZ)':             {fov:60, range:100,res:'2MP',poeW:30},
  'Generic Dahua':                   {fov:90, range:30,res:'4MP',poeW:8},
  // Reolink
  'RLC-823A':         {fov:105,range:60,  res:'4K',   poeW:24},
  'RLC-1224A':        {fov:93, range:30,  res:'12MP', poeW:12},
  'RLC-820A':         {fov:87, range:30,  res:'4K',   poeW:12},
  'RLC-410W':         {fov:80, range:30,  res:'5MP',  poeW:0},
  'Argus 4 Pro':      {fov:180,range:10,  res:'4K',   poeW:0},
  'TrackMix PoE': {fov:104,range:30, res:'4K',   poeW:12},
  'Trackmix':         {fov:104,range:30, res:'4K',   poeW:12}, // Legacy saved projects.
  'RLC-833A':         {fov:94, range:30,  res:'4K',   poeW:12},
  'RLC-811A':         {fov:105,range:30,  res:'4K',   poeW:12},
  'RLC-810A 2.8mm':   {fov:101,range:30,  res:'4K',   poeW:12},
  'RLC-1212A':        {fov:97, range:30,  res:'12MP', poeW:12},
  'Duo 2 PoE': {fov:180,range:30, res:'8MP',  poeW:12},
  'Duo 3 PoE': {fov:180,range:30, res:'16MP', poeW:12},
  'RLC-823S2':        {fov:54.2,range:80, res:'4K',   poeW:24},
  // Axis
  'M3045-V':          {fov:118,range:0,   res:'1080p',poeW:4},
  'M3046-V':          {fov:106,range:0,   res:'4MP',  poeW:4},
  'M3057-PLVE':       {fov:360,range:15,  res:'6MP',  poeW:8},
  'P3245-LV':         {fov:103,range:40,  res:'1080p',poeW:14},
  'Q6125-LE (PTZ)':   {fov:65, range:80,  res:'2MP',  poeW:30},
  'Generic Axis':     {fov:90, range:30,  res:'4MP',  poeW:8},
  // Bosch
  'FLEXIDOME IP starlight 8000i':    {fov:100,range:35,res:'6MP',poeW:13},
  'DINION IP starlight 7100i':       {fov:90, range:60,res:'4MP',poeW:13},
  'AUTODOME IP starlight 5100i (PTZ)':{fov:60,range:80,res:'4MP',poeW:30},
  'Generic Bosch':                   {fov:90, range:30,res:'4MP',poeW:10},
  // Vivotek
  'IB9387-HT':        {fov:108,range:50,  res:'5MP',  poeW:9},
  'FD9389-EHTV':      {fov:111,range:30,  res:'5MP',  poeW:9},
  'SD9384-EHL (PTZ)': {fov:60, range:150, res:'2MP',  poeW:30},
  'Generic Vivotek':  {fov:90, range:30,  res:'4MP',  poeW:8},
  // Fallback
  'Custom/Other':     {fov:90, range:30,  res:'4K',   poeW:8},
};

// Heatmap mode definitions. Each mode is a series of stops applied from the
// strongest threshold downward — the first stop whose metric the sample meets
// wins. `unit` is shown in the legend, `metric` names the geometry function
// the renderer must call (see app.js renderHeat).
export const HEATMAP_MODES={
  rssi:{
    label:'RSSI (dBm)',
    unit:'dBm',
    metric:'dbm',
    stops:[
      {v:-55, color:'#1e7d3c', label:'Excellent (-55 dBm)'},
      {v:-65, color:'#76b542', label:'Strong (-65 dBm)'},
      {v:-75, color:'#e7b40e', label:'Fair (-75 dBm)'},
      {v:-85, color:'#e07b22', label:'Weak (-85 dBm)'},
      {v:-95, color:'#c0382b', label:'Unusable (-95 dBm)'},
    ],
  },
  snr:{
    label:'SNR (dB)',
    unit:'dB',
    metric:'snr',
    stops:[
      {v:40, color:'#1e7d3c', label:'Excellent (≥40 dB)'},
      {v:30, color:'#76b542', label:'Strong (≥30 dB)'},
      {v:20, color:'#e7b40e', label:'Fair (≥20 dB)'},
      {v:10, color:'#e07b22', label:'Weak (≥10 dB)'},
      {v:0,  color:'#c0382b', label:'Unusable (<10 dB)'},
    ],
  },
  mcs:{
    label:'MCS index',
    unit:'',
    metric:'mcs',
    stops:[
      {v:9, color:'#1e7d3c', label:'MCS 9+ (HE)'},
      {v:7, color:'#76b542', label:'MCS 7'},
      {v:5, color:'#e7b40e', label:'MCS 5'},
      {v:3, color:'#e07b22', label:'MCS 3'},
      {v:0, color:'#c0382b', label:'MCS 0'},
    ],
  },
  throughput:{
    label:'Throughput (Mbps)',
    unit:'Mbps',
    metric:'mbps',
    stops:[
      {v:500, color:'#1e7d3c', label:'≥500 Mbps'},
      {v:200, color:'#76b542', label:'≥200 Mbps'},
      {v:50,  color:'#e7b40e', label:'≥50 Mbps'},
      {v:10,  color:'#e07b22', label:'≥10 Mbps'},
      {v:0,   color:'#c0382b', label:'<10 Mbps'},
    ],
  },
  sinr:{
    label:'SINR (dB)',
    unit:'dB',
    metric:'sinr',
    stops:[
      {v:30, color:'#1e7d3c', label:'Excellent (≥30 dB)'},
      {v:20, color:'#76b542', label:'Strong (≥20 dB)'},
      {v:13, color:'#e7b40e', label:'Fair (≥13 dB)'},
      {v:5,  color:'#e07b22', label:'Weak (≥5 dB)'},
      {v:-5, color:'#c0382b', label:'Interference-limited (<5 dB)'},
    ],
  },
};
export const HEATMAP_MODE_KEYS=Object.keys(HEATMAP_MODES);

// Legacy named export used by older callsites — points at the RSSI stops.
export const HEATMAP_STOPS=HEATMAP_MODES.rssi.stops.map(s=>({dbm:s.v,color:s.color,label:s.label}));

// Regulatory regions. `channels24/5/6` list the allowed channel numbers for
// each band; `eirpDbm` is the max effective isotropic radiated power for that
// band; `dfs` lists 5 GHz DFS channels (where radar may pre-empt). These are
// approximate; pros doing a real install should verify against current local
// regs. The aim here is to surface "this AP/channel/EIRP combination won't
// fly in your region", not to be a definitive regulator.
export const REGULATORY_REGIONS={
  'FCC-US':{
    label:'FCC — United States',
    channels24:[1,2,3,4,5,6,7,8,9,10,11],
    channels5:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144,149,153,157,161,165],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93,97,101,105,109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233],
    dfs:[52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,144],
    eirpDbm:{ '2.4':30, '5':30, '6':30 },
  },
  'ETSI-EU':{
    label:'ETSI — Europe',
    channels24:[1,2,3,4,5,6,7,8,9,10,11,12,13],
    channels5:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93],
    dfs:[52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    eirpDbm:{ '2.4':20, '5':23, '6':23 },
  },
  'JP':{
    label:'Japan (MIC)',
    channels24:[1,2,3,4,5,6,7,8,9,10,11,12,13,14],
    channels5:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93],
    dfs:[52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    eirpDbm:{ '2.4':20, '5':23, '6':23 },
  },
  'AU-NZ':{
    label:'AU / NZ (ACMA)',
    channels24:[1,2,3,4,5,6,7,8,9,10,11,12,13],
    channels5:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,149,153,157,161,165],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93],
    dfs:[52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    eirpDbm:{ '2.4':20, '5':23, '6':23 },
  },
  'IN':{
    label:'India (WPC)',
    channels24:[1,2,3,4,5,6,7,8,9,10,11,12,13],
    channels5:[36,40,44,48,149,153,157,161,165],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93],
    dfs:[],
    eirpDbm:{ '2.4':20, '5':23, '6':23 },
  },
  'BR':{
    label:'Brazil (Anatel)',
    channels24:[1,2,3,4,5,6,7,8,9,10,11],
    channels5:[36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,149,153,157,161,165],
    channels6:[1,5,9,13,17,21,25,29,33,37,41,45,49,53,57,61,65,69,73,77,81,85,89,93,97,101,105,109,113,117,121,125,129,133,137,141,145,149,153,157,161,165,169,173,177,181,185,189,193,197,201,205,209,213,217,221,225,229,233],
    dfs:[52,56,60,64,100,104,108,112,116,120,124,128,132,136,140],
    eirpDbm:{ '2.4':30, '5':30, '6':30 },
  },
};
export const REGULATORY_REGION_KEYS=Object.keys(REGULATORY_REGIONS);
export const DEFAULT_REGULATORY_REGION='FCC-US';

// Propagation models the user can switch between. Affects the path-loss term
// inside `dbmAt`. Walls and band factors are applied on top by all of them.
//   logd        — log-distance, the v1/v2 model (25 dB across the AP radius).
//   itu-indoor  — ITU P.1238 indoor model with floor penalty handled separately.
//   multi-wall  — COST-231-style, distance-only term identical to itu-indoor.
// Exponents come from geometry.js (PROP_EXPONENT) — single source of truth so
// the UI and the RF math never drift.
export const PROPAGATION_MODELS={
  'logd':       {label:'Log-distance (default)', exponent:PROP_EXPONENT['logd']},
  'itu-indoor': {label:'ITU-R P.1238 (indoor)',  exponent:PROP_EXPONENT['itu-indoor']},
  'multi-wall': {label:'COST-231 multi-wall',    exponent:PROP_EXPONENT['multi-wall']},
};
export const PROPAGATION_MODEL_KEYS=Object.keys(PROPAGATION_MODELS);
export const DEFAULT_PROPAGATION_MODEL='logd';

// Roaming-overlap target: signal level (dBm) below which the overlay reports
// no overlap from this AP. -67 dBm = the classic "voice/roaming" sweet spot.
export const ROAMING_OVERLAP_DBM=-67;

// Default floor-to-floor slab attenuation in dB. 18 dB ≈ a typical concrete
// slab with rebar at 5 GHz. User-configurable per-project.
export const DEFAULT_FLOOR_SLAB_DB=18;

// ── Device install status ──────────────────────────────────────────────────
// Rollout lifecycle for APs / cameras / switches. Order matters: it's the
// chronological pipeline, and "progress" = how far right the fleet has moved.
export const DEVICE_STATUSES=['planned','ordered','installed','tested','live'];
export const DEVICE_STATUS_META={
  planned:   {label:'Planned',   color:'#8a8a8a'},
  ordered:   {label:'Ordered',   color:'#b8860b'},
  installed: {label:'Installed', color:'#1565c0'},
  tested:    {label:'Tested',    color:'#6a1b9a'},
  live:      {label:'Live',      color:'#1e7d3c'},
};

// Curated AP color palette — chosen to read clearly on the cream Plexus canvas.
// Empty value means "use default ink (#000)".
export const AP_COLORS=[
  {value:'',         label:'Default'},
  {value:'#c0382b',  label:'Red'},
  {value:'#d68910',  label:'Amber'},
  {value:'#1e7d3c',  label:'Green'},
  {value:'#1565c0',  label:'Blue'},
  {value:'#6a1b9a',  label:'Purple'},
  {value:'#00838f',  label:'Teal'},
  {value:'#6d4c41',  label:'Brown'},
];

// Architect's-scale presets. Each entry maps a paper-scale denominator to the
// equivalent "metres per 100 px" value at 100 DPI. The user can pick one in
// settings to lock scaleM to a clean integer.
export const ARCH_SCALE_PRESETS=[
  {label:'1:50',  m100px:1.27},
  {label:'1:100', m100px:2.54},
  {label:'1:200', m100px:5.08},
  {label:'1:500', m100px:12.7},
  {label:'1:1000',m100px:25.4},
];

// Per-model product image paths, keyed by the exact catalog model name. Images
// are bundled locally (downloaded by scripts/fetch-device-images.mjs into
// files/public/devices/, which Vite copies into dist/) so previews work offline
// with no runtime CDN dependency. Side-panel preview resolves:
//   device.imageUrl (per-device override) -> MODEL_IMAGES[model] -> category placeholder.
// Re-run the script to add or refresh models.
import {MODEL_IMAGES} from './deviceImages.js';
export {MODEL_IMAGES};

// Build a neutral inline-SVG data URI from a glyph body + caption. Inline so it
// always renders, even from file:// and offline. Styled to read on the cream
// Plexus canvas (same palette as the empty-state UI).
function _phSvg(inner,label){
  return 'data:image/svg+xml;utf8,'+encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90">`
    +`<rect width="160" height="90" fill="#e9e4d8"/>`
    +`<g fill="none" stroke="#b8b0a0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
    +`<text x="80" y="83" font-family="sans-serif" font-size="9" fill="#8a8270" text-anchor="middle">${label}</text></svg>`);
}

// Per-category placeholders, picked when a model has no mapped/override image.
// A type-specific silhouette reads as intentional, unlike a generic box.
export const MODEL_IMAGE_PLACEHOLDERS={
  // Access point: ceiling-dome dot with radiating signal arcs.
  ap:  _phSvg(`<circle cx="80" cy="44" r="3.5" fill="#b8b0a0" stroke="none"/>`
    +`<path d="M64 44a16 16 0 0 1 32 0"/><path d="M55 44a25 25 0 0 1 50 0"/>`,'access point'),
  // Camera: bullet body + lens + mount arm.
  cam: _phSvg(`<rect x="50" y="32" width="48" height="24" rx="5"/>`
    +`<circle cx="68" cy="44" r="8"/><line x1="98" y1="44" x2="112" y2="44"/>`
    +`<line x1="112" y1="38" x2="112" y2="50"/>`,'camera'),
  // Switch: 1U chassis with a row of ports.
  sw:  _phSvg(`<rect x="38" y="34" width="84" height="22" rx="2"/>`
    +`<path d="M48 52v-6M57 52v-6M66 52v-6M75 52v-6M84 52v-6M93 52v-6M102 52v-6M111 52v-6"/>`,'switch'),
  // Generic fallback for anything without a category.
  default: _phSvg(`<rect x="34" y="22" width="92" height="46" rx="4"/><circle cx="80" cy="45" r="11"/>`,'no image'),
};

// Back-compat: the original single-placeholder export now points at the generic
// fallback. Existing callers keep working; type-aware callers pass a `type`.
export const MODEL_IMAGE_PLACEHOLDER=MODEL_IMAGE_PLACEHOLDERS.default;

/**
 * Resolve a device's preview image URL.
 * @param {{imageUrl?:string, model?:string}} item
 * @param {('ap'|'cam'|'sw')=} type  Device category, for the fallback silhouette.
 * @returns {string} A usable <img src> (override, mapped, or category placeholder).
 */
export function modelImageUrl(item,type){
  if(item&&typeof item.imageUrl==='string'&&item.imageUrl.trim())return item.imageUrl.trim();
  const mapped=item&&item.model&&MODEL_IMAGES[item.model];
  if(mapped)return mapped;
  return MODEL_IMAGE_PLACEHOLDERS[type]||MODEL_IMAGE_PLACEHOLDERS.default;
}
