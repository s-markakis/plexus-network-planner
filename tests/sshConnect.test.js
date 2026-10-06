import { describe, it, expect } from 'vitest';
import { sshTarget, sshCommand, sshVendor } from '../files/src/sshConnect.js';

describe('sshTarget', () => {
  it('resolves from explicit ssh creds', () => {
    const d = { ip: '10.0.0.9', creds: { proto: 'ssh', host: '192.0.2.10', port: '2222', user: 'admin' } };
    expect(sshTarget(d)).toEqual({ host: '192.0.2.10', user: 'admin', port: 2222, key: '' });
  });
  it('falls back to the device IP when no creds.host', () => {
    const d = { ip: '192.0.2.10', creds: { proto: 'ssh', user: 'admin' } };
    expect(sshTarget(d)).toMatchObject({ host: '192.0.2.10', user: 'admin', port: 22 });
  });
  it('defaults the port to 22 when unset or garbage', () => {
    expect(sshTarget({ ip: 'h', creds: { port: '' } }).port).toBe(22);
    expect(sshTarget({ ip: 'h', creds: { port: 'abc' } }).port).toBe(22);
  });
  it('surfaces a key path from creds or an imported ssh target', () => {
    expect(sshTarget({ ip: 'h', creds: { identityFile: '~/.ssh/id_ed25519' } }).key).toBe('~/.ssh/id_ed25519');
    expect(sshTarget({ ip: 'h', ssh: { identityFile: '/k' } }).key).toBe('/k');
  });
  it('returns null without a host or IP', () => {
    expect(sshTarget({ creds: { user: 'admin' } })).toBeNull();
    expect(sshTarget(null)).toBeNull();
    expect(sshTarget({})).toBeNull();
  });
});

describe('sshCommand', () => {
  it('builds user@host with a non-default port and key', () => {
    const d = { creds: { host: '192.0.2.10', port: '2222', user: 'admin', identityFile: '~/.ssh/k' } };
    expect(sshCommand(d)).toBe('ssh -i ~/.ssh/k -p 2222 admin@192.0.2.10');
  });
  it('omits -p for port 22 and omits user@ when no user', () => {
    expect(sshCommand({ ip: '192.0.2.10' })).toBe('ssh 192.0.2.10');
    expect(sshCommand({ creds: { host: 'h', user: 'admin' } })).toBe('ssh admin@h');
  });
  it('is null when there is nothing to connect to', () => {
    expect(sshCommand({})).toBeNull();
  });
});

describe('sshVendor', () => {
  it('detects mikrotik and cisco from the model, else generic', () => {
    expect(sshVendor('MikroTik hAP ax lite')).toBe('mikrotik');
    expect(sshVendor('Catalyst 9300')).toBe('cisco');
    expect(sshVendor('U6 Pro')).toBe('generic');
  });
});
