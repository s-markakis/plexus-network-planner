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
    IdentityFile ~/.ssh/id_ed25519
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
