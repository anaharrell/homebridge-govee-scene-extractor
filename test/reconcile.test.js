'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { accessoryUUIDSource } = require('../lib/state');
const { GoveeSceneExtractor } = require('../index');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const GARAGE_ID = '9A:00:00:00:00:00:00:02';

function createFakeService() {
  const characteristic = {
    removeAllListeners() { return this; },
    onGet() { return this; },
    onSet() { return this; }
  };

  return {
    setCharacteristic() { return this; },
    getCharacteristic() { return characteristic; },
    updateCharacteristic() { return this; }
  };
}

class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
    this._services = new Map();
  }

  getService(kind) {
    if (!this._services.has(kind))
      this._services.set(kind, createFakeService());

    return this._services.get(kind);
  }

  addService(kind) {
    return this.getService(kind);
  }
}

function createFakeApi() {
  const registered = [];
  const unregistered = [];

  return {
    hap: {
      Service: {
        Switch: 'Switch',
        AccessoryInformation: 'AccessoryInformation'
      },
      Characteristic: {
        On: 'On',
        Manufacturer: 'Manufacturer',
        Model: 'Model'
      },
      uuid: {
        generate(source) {
          return `uuid(${source})`;
        }
      }
    },
    user: {
      storagePath: () => '/tmp',
      persistPath: () => '/tmp'
    },
    on() {},
    platformAccessory: FakeAccessory,
    registerPlatformAccessories(pn, pl, list) {
      registered.push(...list);
    },
    unregisterPlatformAccessories(pn, pl, list) {
      unregistered.push(...list);
    },
    registered,
    unregistered
  };
}

function silentLog() {
  return { info() {}, warn() {}, debug() {} };
}

function livePlugin(api, ignoreDevices = ['Garage Door LightStrip']) {
  const plugin = new GoveeSceneExtractor(silentLog(), {
    ignoreDevices,
    deviceMap: { 'House Lights': HOUSE_ID }
  }, api);

  plugin.devices.set(HOUSE_ID, {
    id: HOUSE_ID,
    name: 'House Lights',
    sku: 'H706A',
    ip: '192.168.1.20',
    included: true
  });
  plugin.devices.set(GARAGE_ID, {
    id: GARAGE_ID,
    name: 'Garage Door LightStrip',
    sku: 'H6173',
    ip: '192.168.1.10',
    included: false
  });
  plugin.scenes.set('House Lights\0Coming Home', {
    deviceId: HOUSE_ID,
    deviceName: 'House Lights',
    sceneName: 'Coming Home',
    code: ['aaa', 'bbb', 'ccc'],
    included: true
  });
  plugin.scenes.set('Garage Door LightStrip\0HomeBridge Test', {
    deviceId: GARAGE_ID,
    deviceName: 'Garage Door LightStrip',
    sceneName: 'HomeBridge Test',
    code: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    included: true
  });
  plugin.scenes.set('Office Downlight 01\0Ignored Device Test', {
    deviceId: '',
    deviceName: 'Office Downlight 01',
    sceneName: 'Ignored Device Test',
    code: Array(11).fill('x'),
    included: true
  });

  return plugin;
}

describe('reconcileAccessories', () => {
  it('registers a missing desired accessory and does not duplicate Coming Home', () => {
    const api = createFakeApi();
    const plugin = livePlugin(api);
    const comingHomeUuid = api.hap.uuid.generate(
      accessoryUUIDSource(HOUSE_ID, 'Coming Home')
    );
    const cached = new FakeAccessory('Coming Home', comingHomeUuid);
    plugin.configureAccessory(cached);

    plugin.reconcileAccessories();

    assert.equal(api.registered.length, 0);
    assert.equal(api.unregistered.length, 0);
    assert.equal(plugin.acc.get(comingHomeUuid), cached);
    assert.equal(cached.context.sceneName, 'Coming Home');
  });

  it('unregisters a stale excluded accessory and keeps Coming Home', () => {
    const api = createFakeApi();
    const plugin = livePlugin(api);
    const comingHomeUuid = api.hap.uuid.generate(
      accessoryUUIDSource(HOUSE_ID, 'Coming Home')
    );
    const staleUuid = api.hap.uuid.generate(
      accessoryUUIDSource(GARAGE_ID, 'HomeBridge Test')
    );
    const comingHome = new FakeAccessory('Coming Home', comingHomeUuid);
    const stale = new FakeAccessory('HomeBridge Test', staleUuid);
    plugin.configureAccessory(comingHome);
    plugin.configureAccessory(stale);

    plugin.reconcileAccessories();

    assert.equal(api.registered.length, 0);
    assert.equal(api.unregistered.length, 1);
    assert.equal(api.unregistered[0], stale);
    assert.equal(plugin.acc.has(staleUuid), false);
    assert.equal(plugin.acc.get(comingHomeUuid), comingHome);
    assert.equal(
      plugin.scenes.get('Garage Door LightStrip\0HomeBridge Test').included,
      true
    );
  });

  it('registers Coming Home when it is desired but not cached', () => {
    const api = createFakeApi();
    const plugin = livePlugin(api);

    plugin.reconcileAccessories();

    assert.equal(api.registered.length, 1);
    assert.equal(api.registered[0].displayName, 'Coming Home');
    assert.equal(api.unregistered.length, 0);
    assert.equal(
      api.registered[0].UUID,
      api.hap.uuid.generate(accessoryUUIDSource(HOUSE_ID, 'Coming Home'))
    );
  });
});
