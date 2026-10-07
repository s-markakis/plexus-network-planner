import { describe, it, expect } from 'vitest';
import { parseSshConfig, matchDeviceToHost, importSshTargets } from '../files/src/sshConfig.js';

const CONFIG = `
# sample devices
Host lab-core
    HostName 192.0.2.10
    User admin
    IdentityFile ~/.ssh/id_ed25519

Host access-sw1 access-sw1.lan
    HostName 198.51.100.2
    User netops
    Port 2222
    IdentityFile ~/.ssh/access_key

Host *
    User fallback
    IdentityFile ~/.ssh/id_rsa
`;

describe('parseSshConfig', () => {
  it('parses concrete host blocks with their settings', () => {
    const h = parseSshConfig(CONFIG);
    expect(h).toHaveLength(3);
    expect(h[0]).toMatchObject({ patterns: ['lab-core'], hostName: '192.0.2.10', user: 'admin', port: 22, identityFile: '~/.ssh/id_ed25519' });
    expect(h[1]).toMatchObject({ hostName: '198.51.100.2', user: 'netops', port: 2222, identityFile: '~/.ssh/access_key' });
    expect(h[1].patterns).toEqual(['access-sw1', 'access-sw1.lan']);
  });
  it('tolerates empty / comment-only input', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('# just a comment\n\n')).toEqual([]);
  });
});

describe('matchDeviceToHost', () => {
  const hosts = parseSshConfig(CONFIG);
  it('matches by HostName == device IP', () => {
    const t = matchDeviceToHost({ name: 'whatever', ip: '192.0.2.10' }, hosts);
    expect(t).toMatchObject({ host: '192.0.2.10', user: 'admin', identityFile: '~/.ssh/id_ed25519', alias: 'lab-core' });
  });
  it('matches by alias == device name when IP does not match', () => {
    const t = matchDeviceToHost({ name: 'access-sw1', ip: '10.99.99.99' }, hosts);
    expect(t).toMatchObject({ host: '198.51.100.2', user: 'netops', port: 2222 });
  });
  it('never matches on a wildcard Host (*)', () => {
    expect(matchDeviceToHost({ name: 'ghost', ip: '8.8.8.8' }, hosts)).toBeNull();
  });
});

describe('importSshTargets', () => {
  it('assigns matched devices with a netssh vendor and lists the unmatched', () => {
    const hosts = parseSshConfig(CONFIG);
    const devices = [
      { id: 'sw1', name: 'SW-01', ip: '192.0.2.10', model: 'MikroTik hAP ax lite' },
      { id: 'sw2', name: 'access-sw1', ip: '10.0.0.9', model: 'Catalyst 9300' },
      { id: 'sw3', name: 'orphan', ip: '172.16.0.1', model: 'USW-24' },
    ];
    const { assigned, unmatched } = importSshTargets(devices, hosts);
    expect(assigned.find((a) => a.id === 'sw1').ssh).toMatchObject({ host: '192.0.2.10', vendor: 'mikrotik', identityFile: '~/.ssh/id_ed25519' });
    expect(assigned.find((a) => a.id === 'sw2').ssh).toMatchObject({ host: '198.51.100.2', vendor: 'cisco' });
    expect(unmatched.map((u) => u.id)).toEqual(['sw3']);
  });
});

describe('ssh-config parser edge cases (adversarial)', () => {
  it('handles Key=Value syntax', () => {
    const h = parseSshConfig('Host=villa\n  HostName=10.0.0.1\n  User=admin');
    expect(h[0]).toMatchObject({ patterns: ['villa'], hostName: '10.0.0.1', user: 'admin' });
  });
  it('is case-insensitive on keywords', () => {
    const h = parseSshConfig('HOST core\n  HostName 10.0.0.2\n  USER root\n  IDENTITYFILE ~/.ssh/k');
    expect(h[0]).toMatchObject({ hostName: '10.0.0.2', user: 'root', identityFile: '~/.ssh/k' });
  });
  it('takes the first IdentityFile when several are listed', () => {
    const h = parseSshConfig('Host a\n IdentityFile ~/.ssh/first\n IdentityFile ~/.ssh/second');
    expect(h[0].identityFile).toBe('~/.ssh/first');
  });
  it('matches a concrete alias in a mixed wildcard block', () => {
    const h = parseSshConfig('Host edge *.lan\n HostName 10.0.0.3\n User op');
    expect(matchDeviceToHost({ name: 'edge', ip: '' }, h)).toMatchObject({ host: '10.0.0.3', user: 'op' });
    expect(matchDeviceToHost({ name: 'anything.lan', ip: '' }, h)).toBeNull(); // wildcard never matches
  });
});

describe('matchDeviceToHost robustness', () => {
  it('a device with neither name nor ip matches nothing', () => {
    const h = parseSshConfig('Host x\n HostName 1.2.3.4');
    expect(matchDeviceToHost({}, h)).toBeNull();
    expect(matchDeviceToHost({ name: '', ip: '' }, h)).toBeNull();
  });
  it('never returns a target with no host (alias-only block, no device IP)', () => {
    const h = parseSshConfig('Host aliasonly\n User admin'); // no HostName, no resolvable address
    const t = matchDeviceToHost({ name: 'aliasonly', ip: '' }, h);
    // must not hand back a connect target with host null/empty
    expect(t === null || (t && t.host)).toBeTruthy();
  });
  it('an alias-only block still works if the device carries an IP', () => {
    const h = parseSshConfig('Host core-sw\n User admin\n IdentityFile ~/.ssh/k');
    const t = matchDeviceToHost({ name: 'core-sw', ip: '10.9.9.9' }, h);
    expect(t).toMatchObject({ host: '10.9.9.9', user: 'admin' });
  });
});

describe('importSshTargets robustness', () => {
  it('skips devices with no id and tolerates a null device list', () => {
    const h = parseSshConfig('Host a\n HostName 10.0.0.1');
    expect(() => importSshTargets(null, h)).not.toThrow();
    const r = importSshTargets([null, {}, { id: 'ok', ip: '10.0.0.1' }], h);
    expect(r.assigned.map((a) => a.id)).toEqual(['ok']);
  });
  it('tolerates an empty / missing config', () => {
    const r = importSshTargets([{ id: 'a', ip: '1.1.1.1' }], parseSshConfig(''));
    expect(r.assigned).toEqual([]);
    expect(r.unmatched.map((u) => u.id)).toEqual(['a']);
  });
});
