import { describe, it, expect } from 'vitest';
import { buildClientReportModel, renderClientReport, surveyStats, equipmentList, reportLang } from '../files/src/clientReport.js';

const XSS = '"><img src=x onerror=alert(1)>';
const floors = () => [{
  name: 'Ground', scaleM: 5,
  APS: [
    { id: 'ap1', name: 'AP-01', model: 'U6 Pro', ip: '192.0.2.11', mac: 'AA:BB:CC:00:11:22', vlan: '10', port: '3', notes: 'behind the bar — INTERNAL', creds: { user: 'admin', pass: 'S3cret-Report' } },
    { id: 'ap2', name: 'AP-02', model: 'U6 Pro', ip: '192.0.2.12' },
    { id: 'ap3', name: 'AP-03', model: 'U6 LR' },
  ],
  CAMS: [{ id: 'c1', name: 'Cam', model: 'G4 Pro', ip: '192.0.2.50' }],
  SWS: [{ id: 's1', name: 'Core', model: 'CRS326', ip: '192.0.2.1', comment: 'INTERNAL rack key in drawer' }],
  SAMPLES: [{ fx: .1, fy: .1, rssi: -50 }, { fx: .2, fy: .2, rssi: -70 }, { fx: .3, fy: .3, rssi: -60 }, { fx: .4, fy: .4 }],
}, { name: 'First', APS: [], CAMS: [], SWS: [] }];
const model = (settings = {}, fl = floors()) => buildClientReportModel({
  settings: { company: 'Acme Networks', contact: 'info@example.test', siteCode: 'Villa Test', retentionDays: 14, ...settings },
  floors: fl,
  floorViews: [{ src: 'data:image/png;base64,AAAA', overlay: { cw: 800, ch: 600, innerSVG: '<circle cx="1" cy="1" r="1"/>' }, pct: 91 }, { src: '', overlay: null, pct: 0 }],
  coveragePct: 88, clientCapacity: 75, cable: { runs: 4, totalM: 120 }, storageGb: 2500,
  now: new Date('2026-11-15T12:00:00Z'),
});

describe('survey stats', () => {
  it('summarises finite readings only', () => {
    expect(surveyStats(floors()[0].SAMPLES)).toEqual({ n: 3, avg: -60, min: -70, okPct: 67, target: -67 });
  });
  it('is null when there is nothing measured', () => {
    expect(surveyStats([])).toBe(null); expect(surveyStats(undefined)).toBe(null); expect(surveyStats([{}])).toBe(null);
  });
});

describe('equipment list', () => {
  it('groups by kind and model, APs first', () => {
    expect(equipmentList(floors())).toEqual([
      { kind: 'AP', model: 'U6 LR', qty: 1 }, { kind: 'AP', model: 'U6 Pro', qty: 2 },
      { kind: 'Camera', model: 'G4 Pro', qty: 1 }, { kind: 'Switch', model: 'CRS326', qty: 1 },
    ]);
  });
  it('tolerates missing lists and blank models', () => {
    expect(equipmentList([{ APS: [{}] }, null, {}])).toEqual([{ kind: 'AP', model: '—', qty: 1 }]);
  });
});

describe('client report', () => {
  it('keeps engineering and secret details out', () => {
    const m = model();
    const html = renderClientReport(m);
    for (const leak of ['192.0.2.', 'AA:BB:CC', 'S3cret-Report', 'INTERNAL', 'admin']) {
      expect(JSON.stringify(m), `model leaks ${leak}`).not.toContain(leak);
      expect(html, `report leaks ${leak}`).not.toContain(leak);
    }
  });

  it('shows the things a client needs', () => {
    const html = renderClientReport(model());
    expect(html).toContain('Acme Networks');
    expect(html).toContain('Villa Test');
    expect(html).toContain('88%');
    expect(html).toContain('91% coverage');
    expect(html).toContain('U6 Pro');
    expect(html).toContain('about 120 m of cable');
    expect(html).toContain('14 days');
    expect(html).toContain('2.5 TB');
    expect(html).toContain('3 measurement points');
    expect(html).toContain('No floor plan for this floor.');
    expect(html).toContain('Acceptance');
  });

  it('escapes everything that comes from the project', () => {
    const fl = floors();
    fl[0].name = XSS; fl[0].APS[0].model = XSS;
    const html = renderClientReport(model({ company: XSS, tagline: XSS, contact: XSS, siteCode: XSS, footerLine: XSS }, fl));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('only accepts an image data URL as the logo', () => {
    expect(model({ logoDataUrl: 'javascript:alert(1)' }).logoDataUrl).toBe('');
    expect(model({ logoDataUrl: 'https://example.test/track.png' }).logoDataUrl).toBe('');
    expect(model({ logoDataUrl: 'data:image/png;base64,AA' }).logoDataUrl).toBe('data:image/png;base64,AA');
  });

  it('omits sections with nothing to say', () => {
    const m = buildClientReportModel({ settings: {}, floors: [{ name: 'F', APS: [{ model: 'X' }], CAMS: [], SWS: [] }],
      floorViews: [{ src: '', overlay: null, pct: 0 }], coveragePct: 0, clientCapacity: 0, cable: { runs: 0, totalM: 0 }, storageGb: 0, now: new Date(0) });
    const html = renderClientReport(m);
    expect(m.cable).toBe(null); expect(m.storage).toBe(null);
    expect(html).not.toContain('<h2><span>Cabling'); expect(html).not.toContain('<h2><span>Video recording');
    expect(html).not.toContain('Measured on site</b>');
  });

  it('is written in Greek for a Greek locale', () => {
    expect(reportLang({ locale: 'el-GR' })).toBe('el');
    expect(reportLang({ language: 'el' })).toBe('el');
    expect(reportLang({ locale: 'en-GB', language: 'en' })).toBe('en');
    const html = renderClientReport(model({ locale: 'el-GR' }));
    expect(html).toContain('Πρόταση Δικτύου');
    expect(html).toContain('Εξοπλισμός');
    expect(html).toContain('3 σημεία μέτρησης');
    expect(html).toContain('lang="el"');
  });
});
