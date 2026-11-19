'use strict';

const assert = require('assert');
const net = require('../scripts/lib/localNetwork');
const deploy = require('../scripts/deploy');

describe('local network instances', function () {
  it('regtest runs the seed, both stand-ins, and the operator', function () {
    const names = net.instancesFor('regtest').map((i) => i.name);
    assert.deepStrictEqual(names, ['seed', 'hub-fabric-pub', 'hub-goon-vc', 'operator']);
  });

  it('signet has no seed but keeps the operator', function () {
    const names = net.instancesFor('signet').map((i) => i.name);
    assert.deepStrictEqual(names, ['hub-fabric-pub', 'hub-goon-vc', 'operator']);
  });

  it('testnet5 has no seed, stays pruned, and connects out', function () {
    const profile = net.networkProfile('testnet5');
    assert.strictEqual(profile.base, 33000);
    assert.strictEqual(profile.seed, false);
    assert.strictEqual(profile.prune, 550);
    assert.strictEqual(profile.beaconIntervalMs, 0);
    const names = net.instancesFor('testnet5').map((i) => i.name);
    assert.deepStrictEqual(names, ['hub-fabric-pub', 'hub-goon-vc', 'operator']);
    const operator = net.instancesFor('testnet5').find((i) => i.name === 'operator');
    assert.strictEqual(operator.ports.http, 33188);
    const peers = net.bitcoinPeersFor(profile, { isSeed: false, remotePeers: ['hub.fabric.pub:18353'] });
    assert.deepStrictEqual(peers, profile.bitcoinPeers);
    assert.ok(peers.includes('wormer.libbitcoin.net:18353'));
    assert.ok(peers.includes('carmine.libbitcoin.net:18353'));
    assert.ok(peers.includes('lapis.erisian.com.au:18353'));
    const fragment = net.buildFragment({
      network: 'testnet5',
      instance: operator,
      dir: '/tmp/x',
      key: { xprv: 'xprv' },
      bitcoinPeers: peers
    });
    assert.strictEqual(fragment.bitcoin.network, 'testnet5');
    assert.strictEqual(fragment.beacon.enable, false);
    assert.ok(fragment.bitcoin.bitcoinExtraParams.includes('-dnsseed=0'));
    assert.ok(fragment.bitcoin.bitcoinExtraParams.includes('-fallbackfee=0.00001'));
    assert.ok(!fragment.bitcoin.bitcoinExtraParams.includes('-connect=0'));
    for (const peer of peers) {
      assert.ok(fragment.bitcoin.bitcoinExtraParams.includes(`-connect=${peer}`), peer);
    }
    const seedPeers = net.bitcoinPeersFor(profile, { isSeed: true, remotePeers: ['hub.fabric.pub:18353'] });
    assert.strictEqual(seedPeers[0], 'hub.fabric.pub:18353');
    assert.ok(seedPeers.includes('lapis.erisian.com.au:18353'));
  });

  it('drops the stand-ins when the public Hubs take part, keeping ports', function () {
    const all = net.instancesFor('regtest');
    const withRemotes = net.instancesFor('regtest', null, { remotes: true });
    assert.deepStrictEqual(withRemotes.map((i) => i.name), ['seed', 'operator']);
    const operator = (list) => list.find((i) => i.name === 'operator').ports;
    assert.deepStrictEqual(operator(withRemotes), operator(all));
  });

  it('keeps the operator clear of the slot just past the instances', function () {
    const list = net.instancesFor('regtest');
    const ports = list.find((i) => i.name === 'operator').ports;
    assert.strictEqual(ports.http, 30188);
    assert.ok(!list.some((i) => i.name !== 'operator' && i.ports.http === ports.http));
    assert.notStrictEqual(ports.http, 30000 + 180 + 3);
  });

  it('dials only the peers it was given, not whoever bitcoind remembers', function () {
    const list = net.instancesFor('regtest');
    const seed = list[0];
    const operator = list.find((i) => i.name === 'operator');
    const key = { xprv: 'xprv' };
    const seedAlone = net.buildFragment({ network: 'regtest', instance: seed, dir: '/tmp/x', key });
    assert.ok(seedAlone.bitcoin.bitcoinExtraParams.includes('-connect=0'));
    assert.ok(!seedAlone.bitcoin.bitcoinExtraParams.some((p) => String(p).startsWith('-addnode=')));
    const member = net.buildFragment({
      network: 'regtest', instance: operator, dir: '/tmp/x', key, seedPort: seed.ports.btcP2p
    });
    assert.ok(member.bitcoin.bitcoinExtraParams.includes(`-connect=127.0.0.1:${seed.ports.btcP2p}`));
    const joined = net.buildFragment({
      network: 'regtest', instance: seed, dir: '/tmp/x', key, bitcoinPeers: ['hub.fabric.pub:18444']
    });
    assert.ok(joined.bitcoin.bitcoinExtraParams.includes('-connect=hub.fabric.pub:18444'));
    assert.ok(!joined.bitcoin.bitcoinExtraParams.includes('-connect=0'));
  });

  it('lets a public chain sync from the internet when it was given no peers', function () {
    const operator = net.instancesFor('signet').find((i) => i.name === 'operator');
    const fragment = net.buildFragment({ network: 'signet', instance: operator, dir: '/tmp/x', key: { xprv: 'xprv' } });
    assert.ok(!fragment.bitcoin.bitcoinExtraParams.some((p) => String(p).startsWith('-connect=')));
  });

  it('passes redial-only Fabric peers through without adding them to the boot dials', function () {
    const operator = net.instancesFor('regtest').find((i) => i.name === 'operator');
    const opts = { network: 'regtest', instance: operator, dir: '/tmp/x', key: { xprv: 'xprv' }, fabricPeers: ['127.0.0.1:7777'] };
    assert.deepStrictEqual(net.buildFragment(opts).redialPeers, []);
    const fragment = net.buildFragment(Object.assign({ redialPeers: ['hub.fabric.pub:7777'] }, opts));
    assert.deepStrictEqual(fragment.redialPeers, ['hub.fabric.pub:7777']);
    assert.deepStrictEqual(fragment.peers, ['127.0.0.1:7777']);
  });

  it('turns the seed Beacon off when it should not mine', function () {
    const seed = net.instancesFor('regtest')[0];
    const opts = { network: 'regtest', instance: seed, dir: '/tmp/x', key: { xprv: 'xprv' } };
    assert.strictEqual(net.buildFragment(opts).beacon.enable, true);
    assert.strictEqual(net.buildFragment(Object.assign({ mine: false }, opts)).beacon.enable, false);
  });

  it('deploy --playnet starts no stand-ins', function () {
    const ctx = deploy.context({ network: 'regtest', playnet: true, root: '/tmp/fabric-localnet-test' });
    assert.deepStrictEqual(ctx.instances.map((i) => i.name), ['seed', 'operator']);
    assert.strictEqual(ctx.remotes.length, 2);
  });

  it('deploy --additive keeps the whole local network and adds the public Hubs', function () {
    assert.strictEqual(deploy.parseArgs(['--additive']).additive, true);
    const ctx = deploy.context({ network: 'regtest', additive: true, root: '/tmp/fabric-localnet-test' });
    assert.deepStrictEqual(ctx.instances.map((i) => i.name), ['seed', 'hub-fabric-pub', 'hub-goon-vc', 'operator']);
    assert.strictEqual(ctx.additive, true);
    assert.strictEqual(ctx.remotes.length, 2);
  });

  it('deploy --only starts just the named instances, keeping their ports', function () {
    assert.deepStrictEqual(deploy.parseArgs(['--only', 'operator']).only, ['operator']);
    assert.deepStrictEqual(deploy.parseArgs(['--only', 'seed,operator', '--only', 'hub-goon-vc']).only, ['seed', 'operator', 'hub-goon-vc']);
    const all = deploy.context({ network: 'mainnet', root: '/tmp/fabric-localnet-test' });
    const ctx = deploy.context({ network: 'mainnet', only: ['operator'], root: '/tmp/fabric-localnet-test' });
    assert.deepStrictEqual(ctx.instances.map((i) => i.name), ['operator']);
    assert.deepStrictEqual(ctx.instances[0].ports, all.instances.find((i) => i.name === 'operator').ports);
    assert.strictEqual(ctx.instances[0].ports.http, 32188);
    assert.throws(() => deploy.context({ network: 'mainnet', only: ['seed'], root: '/tmp/fabric-localnet-test' }), /no such instance on mainnet/);
  });

  it('re-signs a saved admin token only when the identity key no longer verifies it', function () {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const Key = require('@fabric/core/types/key');
    const Token = require('@fabric/core/types/token');
    const { hubServerKeys } = require('../functions/hubAccount');
    const { isOperatorAdminToken } = require('../functions/operatorAdminToken');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-localnet-token-'));
    try {
      const key = net.ensureInstanceKey(dir);
      const { identity } = hubServerKeys({ _rootKey: new Key({ xprv: key.xprv }), settings: { network: 'regtest' } });
      const tokenFile = path.join(dir, 'admin-token.txt');
      assert.strictEqual(net.refreshAdminToken(key, tokenFile, 'regtest'), null, 'no saved token');

      const stale = new Token({ capability: 'OP_IDENTITY', issuer: new Key(), subject: 'admin' }).toSignedString();
      fs.writeFileSync(tokenFile, stale + '\n');
      const fresh = net.refreshAdminToken(key, tokenFile, 'regtest');
      assert.ok(fresh && fresh !== stale);
      assert.ok(isOperatorAdminToken(fresh, [identity]));
      assert.strictEqual(fs.readFileSync(tokenFile, 'utf8').trim(), fresh);
      assert.strictEqual(fs.statSync(tokenFile).mode & 0o777, 0o600);

      assert.strictEqual(net.refreshAdminToken(key, tokenFile, 'regtest'), null, 'a valid token is kept');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds only the bitcoind running on an instance datadir', function () {
    const datadir = '/x/stores/local-network/regtest/operator/bitcoin-datadir';
    const listing = [
      `  101 bitcoind -port=30452 -regtest -datadir=${datadir} -connect=127.0.0.1:30444`,
      `  102 /Users/me/Library/Application Support/Fabric Hub/binaries/darwin-arm64/bitcoind -datadir=${datadir}`,
      `  103 bitcoind -datadir=${datadir}2`,
      `  104 bitcoind -datadir=/x/stores/local-network/regtest/seed/bitcoin-datadir`,
      `  105 bitcoin-cli -regtest -datadir=${datadir} stop`,
      `  106 grep bitcoind -datadir=${datadir}`,
      `  107 bitcoind -regtest -datadir=${datadir}`
    ].join('\n');
    assert.deepStrictEqual(net.bitcoindPidsFromPs(listing, datadir), [101, 102, 107]);
    assert.deepStrictEqual(net.bitcoindPidsFromPs('', datadir), []);
  });

  it('stops a bitcoind left running on the instance datadir', async function () {
    if (process.platform === 'win32') this.skip();
    this.timeout(15000);
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-localnet-bitcoind-'));
    const bin = path.join(dir, 'bin', 'bitcoind');
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, '#!/bin/sh\ntrap "exit 0" TERM\nwhile :; do sleep 0.1; done\n', { mode: 0o755 });
    const child = spawn(bin, ['-regtest', `-datadir=${path.join(dir, 'bitcoin-datadir')}`], { stdio: 'ignore' });
    try {
      await net.sleep(300);
      assert.ok(net.pidAlive(child.pid));
      assert.strictEqual(await net.stopBitcoind(dir), 1);
      assert.ok(!net.pidAlive(child.pid));
      assert.strictEqual(await net.stopBitcoind(dir), 0, 'nothing left to stop');
    } finally {
      try { child.kill('SIGKILL'); } catch (_) {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
