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
  ]
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
      '&sid=abc123&fp=chrome&type=tcp&encryption=none#My%20Laptop'
    );
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
