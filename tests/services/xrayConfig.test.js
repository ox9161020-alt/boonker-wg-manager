'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAMPLE_CONFIG = {
  inbounds: [
    { tag: 'api', protocol: 'dokodemo-door', settings: { address: '127.0.0.1' } },
    {
      tag: 'vless-in',
      protocol: 'vless',
      settings: {
        clients: [
          { id: 'uuid-aaa', email: 'user-1 | Laptop' },
          { id: 'uuid-bbb', email: 'user-2 | Phone' }
        ],
        decryption: 'none'
      }
    }
  ],
  outbounds: [
    { protocol: 'freedom', tag: 'direct' },
    { protocol: 'dns', tag: 'dns-out' },
  ],
  routing: { rules: [{ type: 'field', inboundTag: ['api'], outboundTag: 'api' }] },
};

let tempDir, configPath, xrayConfig;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-cfg-test-'));
  configPath = path.join(tempDir, 'config.json');
  process.env.XRAY_CONFIG_PATH = configPath;
  jest.resetModules();
  xrayConfig = require('../../src/services/xrayConfig');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true });
  delete process.env.XRAY_CONFIG_PATH;
});

describe('isAvailable', () => {
  it('is false when the config file does not exist', () => {
    expect(xrayConfig.isAvailable()).toBe(false);
  });

  it('is true once the config file is written', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    expect(xrayConfig.isAvailable()).toBe(true);
  });
});

describe('listClients / findClient', () => {
  beforeEach(() => xrayConfig.writeConfig(SAMPLE_CONFIG));

  it('extracts uuid, userId and deviceName for every client', () => {
    expect(xrayConfig.listClients()).toEqual([
      { uuid: 'uuid-aaa', userId: 'user-1', deviceName: 'Laptop' },
      { uuid: 'uuid-bbb', userId: 'user-2', deviceName: 'Phone' }
    ]);
  });

  it('finds a single client by uuid', () => {
    expect(xrayConfig.findClient('uuid-bbb')).toEqual({ uuid: 'uuid-bbb', userId: 'user-2', deviceName: 'Phone' });
  });

  it('returns null for an unknown uuid', () => {
    expect(xrayConfig.findClient('does-not-exist')).toBeNull();
  });
});

describe('addClient', () => {
  it('appends a new client and persists it to disk', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.addClient('uuid-ccc', 'user-3', 'Tablet');

    expect(xrayConfig.listClients()).toHaveLength(3);
    expect(xrayConfig.findClient('uuid-ccc')).toEqual({ uuid: 'uuid-ccc', userId: 'user-3', deviceName: 'Tablet' });
  });

  it('sets the xtls-rprx-vision flow real Reality clients (e.g. Happ) expect', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.addClient('uuid-ccc', 'user-3', 'Tablet');

    const raw = xrayConfig.readConfig();
    const client = raw.inbounds.find((i) => i.tag === 'vless-in').settings.clients.find((c) => c.id === 'uuid-ccc');
    expect(client.flow).toBe(xrayConfig.CLIENT_FLOW);
  });
});

describe('removeClient', () => {
  it('removes an existing client and persists it to disk', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.removeClient('uuid-aaa');

    expect(xrayConfig.listClients()).toEqual([
      { uuid: 'uuid-bbb', userId: 'user-2', deviceName: 'Phone' }
    ]);
  });

  it('throws when the uuid is not found', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    expect(() => xrayConfig.removeClient('missing-uuid')).toThrow('VLESS client not found');
  });
});

describe('buildVlessUri', () => {
  it('builds a vless:// URI from the node\'s Reality env params', () => {
    process.env.SERVER_PUBLIC_IP = '1.2.3.4';
    process.env.XRAY_REALITY_PORT = '443';
    process.env.XRAY_REALITY_PUBLIC_KEY = 'pub-key';
    process.env.XRAY_REALITY_SNI = 'www.samsung.com';
    process.env.XRAY_REALITY_SHORT_ID = 'abc123';

    const uri = xrayConfig.buildVlessUri('uuid-aaa', 'My Laptop');

    expect(uri).toBe(
      'vless://uuid-aaa@1.2.3.4:443?security=reality&pbk=pub-key&sni=www.samsung.com' +
      '&sid=abc123&fp=firefox&type=tcp&flow=xtls-rprx-vision&encryption=none#My%20Laptop'
    );
  });
});

describe('ensureTierOutbounds', () => {
  it('adds the 1/3/5 tier outbounds with their marks when missing', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    const changed = xrayConfig.ensureTierOutbounds();

    expect(changed).toBe(true);
    const raw = xrayConfig.readConfig();
    expect(raw.outbounds.find((o) => o.tag === 'tier-101').streamSettings.sockopt.mark).toBe(101);
    expect(raw.outbounds.find((o) => o.tag === 'tier-103').streamSettings.sockopt.mark).toBe(103);
    expect(raw.outbounds.find((o) => o.tag === 'tier-105').streamSettings.sockopt.mark).toBe(105);
  });

  it('is idempotent — does not duplicate outbounds or report a change on a second call', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.ensureTierOutbounds();
    const changed = xrayConfig.ensureTierOutbounds();

    expect(changed).toBe(false);
    const raw = xrayConfig.readConfig();
    expect(raw.outbounds.filter((o) => o.tag === 'tier-101')).toHaveLength(1);
  });
});

describe('setUserSpeedTier / removeUserSpeedTier', () => {
  it('adds a user-tagged routing rule pointing at the tier outbound', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    const result = xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 3);

    expect(result).toEqual({ ruleTag: 'user-uuid-aaa', outboundTag: 'tier-103', mark: 103 });
    const raw = xrayConfig.readConfig();
    const rule = raw.routing.rules.find((r) => r.ruleTag === 'user-uuid-aaa');
    expect(rule).toEqual({ type: 'field', user: ['user-1 | Laptop'], outboundTag: 'tier-103', ruleTag: 'user-uuid-aaa' });
  });

  it('replaces the previous rule instead of duplicating it when the tier changes', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 1);
    xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 5);

    const raw = xrayConfig.readConfig();
    const rules = raw.routing.rules.filter((r) => r.ruleTag === 'user-uuid-aaa');
    expect(rules).toHaveLength(1);
    expect(rules[0].outboundTag).toBe('tier-105');
  });

  it('does not touch other rules (base rules or other users)', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 1);
    xrayConfig.setUserSpeedTier('uuid-bbb', 'user-2 | Phone', 5);

    const raw = xrayConfig.readConfig();
    expect(raw.routing.rules.find((r) => r.outboundTag === 'api')).toBeDefined();
    expect(raw.routing.rules.find((r) => r.ruleTag === 'user-uuid-aaa').outboundTag).toBe('tier-101');
    expect(raw.routing.rules.find((r) => r.ruleTag === 'user-uuid-bbb').outboundTag).toBe('tier-105');
  });

  it('removes only the named user\'s rule and returns the ruleTag', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 1);

    const removed = xrayConfig.removeUserSpeedTier('uuid-aaa');

    expect(removed).toBe('user-uuid-aaa');
    const raw = xrayConfig.readConfig();
    expect(raw.routing.rules.find((r) => r.ruleTag === 'user-uuid-aaa')).toBeUndefined();
    expect(raw.routing.rules.find((r) => r.outboundTag === 'api')).toBeDefined();
  });

  it('returns null (no-op) when the user never had a tier rule — avoids a needless hot-remove/restart', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    expect(xrayConfig.removeUserSpeedTier('uuid-never-tiered')).toBeNull();
  });
});

describe('getMarkForEmail', () => {
  it('resolves an email to its tier outbound\'s mark', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    xrayConfig.setUserSpeedTier('uuid-aaa', 'user-1 | Laptop', 5);

    expect(xrayConfig.getMarkForEmail('user-1 | Laptop')).toBe(105);
  });

  it('returns null when the user has no tier rule', () => {
    xrayConfig.writeConfig(SAMPLE_CONFIG);
    expect(xrayConfig.getMarkForEmail('user-1 | Laptop')).toBeNull();
  });
});

describe('getRealityPublicParams', () => {
  it('reads public Reality params from env', () => {
    process.env.XRAY_REALITY_PUBLIC_KEY = 'pub-key';
    process.env.XRAY_REALITY_SNI = 'www.samsung.com';
    process.env.XRAY_REALITY_SHORT_ID = 'abc123';
    process.env.XRAY_REALITY_PORT = '443';

    expect(xrayConfig.getRealityPublicParams()).toEqual({
      publicKey: 'pub-key', sni: 'www.samsung.com', shortId: 'abc123', port: '443'
    });
  });
});
