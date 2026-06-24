'use strict';
jest.mock('child_process');

describe('generateKeyPair', () => {
  let spawnSync;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    spawnSync = require('child_process').spawnSync;
  });

  it('calls awg genkey then awg pubkey and returns trimmed keys', () => {
    spawnSync
      .mockReturnValueOnce({ stdout: 'fake-private-key\n', stderr: '', status: 0, error: null })
      .mockReturnValueOnce({ stdout: 'fake-public-key\n', stderr: '', status: 0, error: null });

    const { generateKeyPair } = require('../../src/services/keygen');
    const { privateKey, publicKey } = generateKeyPair();

    expect(spawnSync).toHaveBeenNthCalledWith(1, 'awg', ['genkey'], { encoding: 'utf8' });
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'awg', ['pubkey'], {
      input: 'fake-private-key\n',
      encoding: 'utf8'
    });
    expect(privateKey).toBe('fake-private-key');
    expect(publicKey).toBe('fake-public-key');
  });

  it('throws if awg genkey returns an error', () => {
    const testError = new Error('awg: command not found');
    spawnSync.mockReturnValueOnce({
      stdout: '', stderr: '', status: null, error: testError
    });

    const { generateKeyPair } = require('../../src/services/keygen');
    expect(() => generateKeyPair()).toThrow('awg: command not found');
  });

  it('throws if awg pubkey returns an error', () => {
    const testError = new Error('pubkey failed');
    spawnSync
      .mockReturnValueOnce({ stdout: 'priv\n', stderr: '', status: 0, error: null })
      .mockReturnValueOnce({ stdout: '', stderr: '', status: null, error: testError });

    const { generateKeyPair } = require('../../src/services/keygen');
    expect(() => generateKeyPair()).toThrow('pubkey failed');
  });

  it('throws if awg genkey exits with non-zero status', () => {
    spawnSync.mockReturnValueOnce({
      stdout: '', stderr: 'operation not permitted', status: 1, error: null
    });

    const { generateKeyPair } = require('../../src/services/keygen');
    expect(() => generateKeyPair()).toThrow('operation not permitted');
  });

  it('throws if awg genkey returns empty stdout', () => {
    spawnSync.mockReturnValueOnce({
      stdout: '\n', stderr: '', status: 0, error: null
    });

    const { generateKeyPair } = require('../../src/services/keygen');
    expect(() => generateKeyPair()).toThrow('awg genkey returned empty output');
  });

  it('throws if awg pubkey exits with non-zero status', () => {
    spawnSync
      .mockReturnValueOnce({ stdout: 'priv-key\n', stderr: '', status: 0, error: null })
      .mockReturnValueOnce({ stdout: '', stderr: 'invalid key', status: 1, error: null });

    const { generateKeyPair } = require('../../src/services/keygen');
    expect(() => generateKeyPair()).toThrow('invalid key');
  });
});
