'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE_CONFIG = `[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = server-private-key-aaa
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT

[Peer]
# user-1 | Laptop
PublicKey = peer-pubkey-aaa
AllowedIPs = 10.0.0.2/32

[Peer]
# user-2 | Phone
PublicKey = peer-pubkey-bbb
AllowedIPs = 10.0.0.3/32
`;

let tempDir, configPath, configService;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-cfg-test-'));
  configPath = path.join(tempDir, 'wg0.conf');
  process.env.WG_CONFIG_PATH = configPath;
  jest.resetModules();
  configService = require('../../src/services/config');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true });
  delete process.env.WG_CONFIG_PATH;
});

describe('readConfig / writeConfig', () => {
  it('reads content written by writeConfig', () => {
    configService.writeConfig('hello');
    expect(configService.readConfig()).toBe('hello');
  });
});

describe('parsePeers', () => {
  it('extracts all peers with metadata', () => {
    fs.writeFileSync(configPath, SAMPLE_CONFIG);
    const peers = configService.parsePeers(configService.readConfig());

    expect(peers).toHaveLength(2);
    expect(peers[0]).toEqual({
      publicKey: 'peer-pubkey-aaa',
      allowedIp: '10.0.0.2/32',
      userId: 'user-1',
      deviceName: 'Laptop'
    });
    expect(peers[1]).toEqual({
      publicKey: 'peer-pubkey-bbb',
      allowedIp: '10.0.0.3/32',
      userId: 'user-2',
      deviceName: 'Phone'
    });
  });

  it('returns empty array when no peers exist', () => {
    fs.writeFileSync(configPath, '[Interface]\nAddress = 10.0.0.1/24\n');
    expect(configService.parsePeers(configService.readConfig())).toEqual([]);
  });
});

describe('allocateIp', () => {
  it('allocates 10.0.0.2/32 when no peers exist', () => {
    expect(configService.allocateIp([])).toBe('10.0.0.2/32');
  });

  it('allocates next sequential IP', () => {
    const peers = [{ allowedIp: '10.0.0.2/32' }, { allowedIp: '10.0.0.3/32' }];
    expect(configService.allocateIp(peers)).toBe('10.0.0.4/32');
  });

  it('fills gaps in allocation', () => {
    const peers = [{ allowedIp: '10.0.0.2/32' }, { allowedIp: '10.0.0.4/32' }];
    expect(configService.allocateIp(peers)).toBe('10.0.0.3/32');
  });

  it('allocates from PEER_IP_RANGE instead of the legacy 10.0.0.0/24 when set', () => {
    process.env.PEER_IP_RANGE = '10.0.5.0/24';
    jest.resetModules();
    const scopedConfigService = require('../../src/services/config');
    expect(scopedConfigService.allocateIp([])).toBe('10.0.5.2/32');
    delete process.env.PEER_IP_RANGE;
  });
});

describe('addPeer', () => {
  it('appends a peer block to the config', () => {
    fs.writeFileSync(configPath, SAMPLE_CONFIG);
    configService.addPeer('new-pubkey-ccc', '10.0.0.4/32', 'user-3', 'Tablet');

    const peers = configService.parsePeers(configService.readConfig());
    expect(peers).toHaveLength(3);
    expect(peers[2]).toEqual({
      publicKey: 'new-pubkey-ccc',
      allowedIp: '10.0.0.4/32',
      userId: 'user-3',
      deviceName: 'Tablet'
    });
  });
});

describe('removePeer', () => {
  it('removes the target peer by public key', () => {
    fs.writeFileSync(configPath, SAMPLE_CONFIG);
    configService.removePeer('peer-pubkey-aaa');

    const peers = configService.parsePeers(configService.readConfig());
    expect(peers).toHaveLength(1);
    expect(peers[0].publicKey).toBe('peer-pubkey-bbb');
  });

  it('preserves [Interface] section after removal', () => {
    fs.writeFileSync(configPath, SAMPLE_CONFIG);
    configService.removePeer('peer-pubkey-aaa');

    const content = configService.readConfig();
    expect(content).toContain('[Interface]');
    expect(content).toContain('PrivateKey = server-private-key-aaa');
  });

  it('throws "Peer not found" for unknown public key', () => {
    fs.writeFileSync(configPath, SAMPLE_CONFIG);
    expect(() => configService.removePeer('nonexistent-key')).toThrow('Peer not found');
  });

  it('can remove the last remaining peer', () => {
    const oneUser = `[Interface]\nAddress = 10.0.0.1/24\n\n[Peer]\n# u | d\nPublicKey = only-peer\nAllowedIPs = 10.0.0.2/32\n`;
    fs.writeFileSync(configPath, oneUser);
    configService.removePeer('only-peer');

    const peers = configService.parsePeers(configService.readConfig());
    expect(peers).toHaveLength(0);
  });
});
