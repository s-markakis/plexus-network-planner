import { describe, it, expect } from 'vitest';
import { SITE_TEMPLATES, buildTemplateProject, getSiteTemplate } from '../files/src/siteTemplates.js';
import { migrateProject } from '../files/src/migrate.js';
import { parseCidr, ipInCidr, ipToInt } from '../files/src/network.js';
import { evaluatePolicies } from '../files/src/policy.js';

const range = (cidr) => { const [ip, bits] = cidr.split('/'); const size = 2 ** (32 - +bits); const lo = Math.floor(ipToInt(ip) / size) * size; return [lo, lo + size - 1]; };

describe('site templates', () => {
  it('has unique ids and at least the three site kinds', () => {
    const ids = SITE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['villa', 'hotel', 'restaurant']));
    expect(getSiteTemplate('nope')).toBe(null);
    expect(buildTemplateProject('nope')).toBe(null);
  });

  for (const t of SITE_TEMPLATES) {
    describe(t.id, () => {
      it('loads through the normal project pipeline with nothing to repair', () => {
        const [data, warnings] = migrateProject(buildTemplateProject(t.id));
        expect(warnings).toEqual([]);
        expect(data.floors.map((f) => f.name)).toEqual(t.floors);
        expect(data.settings.vlans.length).toBe(t.settings.vlans.length);
        expect(data.settings.policies.length).toBe(t.settings.policies.length);
        expect(data.floors[0].SWS[0].role).toBe('l3');
      });

      it('VLAN plan: valid, distinct, non-overlapping subnets with the gateway inside', () => {
        const vlans = t.settings.vlans;
        expect(new Set(vlans.map((v) => v.id)).size).toBe(vlans.length);
        for (const v of vlans) {
          expect(parseCidr(v.subnet), v.subnet).toBeTruthy();
          expect(ipInCidr(v.gateway, v.subnet), `${v.gateway} in ${v.subnet}`).toBe(true);
          expect(v.color).toMatch(/^#[0-9a-f]{6}$/i);
          // The subnet is written at its network address (no host bits set).
          expect(ipToInt(v.subnet.split('/')[0])).toBe(range(v.subnet)[0]);
        }
        for (let i = 0; i < vlans.length; i++) for (let j = i + 1; j < vlans.length; j++) {
          const [a0, a1] = range(vlans[i].subnet), [b0, b1] = range(vlans[j].subnet);
          expect(a1 < b0 || b1 < a0, `${vlans[i].subnet} overlaps ${vlans[j].subnet}`).toBe(true);
        }
      });

      it('policies only name VLANs the template defines, and the simulator can judge them', () => {
        const ids = new Set(t.settings.vlans.map((v) => v.id));
        for (const p of t.settings.policies) {
          expect(ids.has(p.from.vlan), `${p.id} from`).toBe(true);
          expect(ids.has(p.to.vlan), `${p.id} to`).toBe(true);
          expect(['allow', 'deny']).toContain(p.expect);
        }
        expect(new Set(t.settings.policies.map((p) => p.id)).size).toBe(t.settings.policies.length);
        const [data] = migrateProject(buildTemplateProject(t.id));
        const out = evaluatePolicies({ settings: data.settings, floors: data.floors }, data.settings.policies);
        expect(out.results.length).toBe(t.settings.policies.length);
      });

      it('building twice gives independent copies', () => {
        const a = buildTemplateProject(t.id); const b = buildTemplateProject(t.id);
        a.settings.vlans[0].name = 'changed'; a.floors[0].SWS[0].name = 'changed';
        expect(b.settings.vlans[0].name).not.toBe('changed');
        expect(getSiteTemplate(t.id).settings.vlans[0].name).not.toBe('changed');
        expect(b.floors[0].SWS[0].name).toBe('Core');
      });
    });
  }
});
