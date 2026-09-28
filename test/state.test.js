'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  accessoryUUIDSource,
  applyLearnedScene,
  associateDeviceName,
  backfillSceneDeviceIds,
  migrateState,
  parseGoveeLine,
  planAccessoryReconciliation,
  shouldPublish
} = require('../lib/state');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const GARAGE_ID = '9A:00:00:00:00:00:00:02';
const COMING_HOME_CODE = ['aaa', 'bbb', 'ccc'];

const v03State = {
  devices: [
    { id: GARAGE_ID, ip: '192.168.1.10', sku: 'H6173' },
    { id: HOUSE_ID, ip: '192.168.1.20', sku: 'H706A' }
  ],
  scenes: [
    {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE
    }
  ]
};

const legacyConfig = {
  deviceMap: { 'House Lights': HOUSE_ID },
  ignoreDevices: [
    'Garage Door LightStrip',
    'Office Downlight 01'
  ]
};

describe('accessory UUID formula', () => {
  it('uses govee-scene-extractor plus device id and scene name', () => {
    assert.equal(
      accessoryUUIDSource(HOUSE_ID, 'Coming Home'),
      `govee-scene-extractor:${HOUSE_ID}:Coming Home`
    );
  });
});

describe('migrateState', () => {
  it('migrates old state without included using deviceMap and ignoreDevices', () => {
    const migrated = migrateState(v03State, legacyConfig);
    const house = migrated.devices.find(d => d.id === HOUSE_ID);
    const garage = migrated.devices.find(d => d.id === GARAGE_ID);
    const comingHome = migrated.scenes.find(s => s.sceneName === 'Coming Home');

    assert.equal(house.name, 'House Lights');
    assert.equal(house.included, true);
    assert.equal(house.ip, '192.168.1.20');
    assert.equal(house.sku, 'H706A');

    assert.equal(garage.name, undefined);
    assert.equal(garage.included, false);

    assert.equal(comingHome.included, true);
    assert.deepEqual(comingHome.code, COMING_HOME_CODE);
    assert.equal(comingHome.deviceId, HOUSE_ID);
  });

  it('is idempotent after included fields exist', () => {
    const first = migrateState(v03State, legacyConfig);
    const second = migrateState(first, legacyConfig);

    assert.deepEqual(second.devices, first.devices);
    assert.deepEqual(second.scenes, first.scenes);
  });
});

describe('shouldPublish', () => {
  it('publishes migrated Coming Home', () => {
    const migrated = migrateState(v03State, legacyConfig);
    const devices = Object.fromEntries(migrated.devices.map(d => [d.id, d]));
    const comingHome = migrated.scenes[0];

    assert.equal(shouldPublish(comingHome, {
      devices,
      ignoreDevices: legacyConfig.ignoreDevices
    }), true);
  });

  it('does not publish a legacy ignored device scene', () => {
    const scene = {
      deviceId: GARAGE_ID,
      deviceName: 'Garage Door LightStrip',
      sceneName: 'HomeBridge Test',
      code: ['xyz'],
      included: true
    };

    assert.equal(shouldPublish(scene, {
      devices: {
        [GARAGE_ID]: {
          id: GARAGE_ID,
          name: 'Garage Door LightStrip',
          included: false
        }
      },
      ignoreDevices: legacyConfig.ignoreDevices
    }), false);

    assert.equal(shouldPublish(scene, {
      devices: {
        [GARAGE_ID]: {
          id: GARAGE_ID,
          name: 'Garage Door LightStrip',
          included: true
        }
      },
      ignoreDevices: legacyConfig.ignoreDevices
    }), true);
  });

  it('does not publish a scene without a device id', () => {
    assert.equal(shouldPublish({
      deviceId: '',
      deviceName: 'Office Downlight 01',
      sceneName: 'Ignored Device Test',
      code: ['xyz'],
      included: true
    }, {
      ignoreDevices: legacyConfig.ignoreDevices
    }), false);
  });

  it('does not publish a brightness-only stub with no scene code', () => {
    assert.equal(shouldPublish({
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: [],
      brightness: 40,
      included: true
    }, {
      devices: {
        [HOUSE_ID]: { id: HOUSE_ID, included: true }
      }
    }), false);
  });

  it('does not publish an associated scene when the device record is missing', () => {
    assert.equal(shouldPublish({
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE,
      included: true
    }, {
      devices: {},
      ignoreDevices: []
    }), false);
  });
});

describe('applyLearnedScene', () => {
  it('learns and persists an ignored-device scene', () => {
    const { scene, changed } = applyLearnedScene(undefined, {
      deviceId: GARAGE_ID,
      deviceName: 'Garage Door LightStrip',
      sceneName: 'HomeBridge Test',
      code: ['xyz']
    });

    assert.equal(changed, true);
    assert.equal(scene.included, true);
    assert.equal(scene.deviceId, GARAGE_ID);
    assert.equal(scene.sceneName, 'HomeBridge Test');
  });

  it('does not treat a duplicate historical scene as a state change', () => {
    const first = applyLearnedScene(undefined, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE
    });

    const second = applyLearnedScene(first.scene, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE
    });

    assert.equal(second.changed, false);
    assert.equal(second.scene, first.scene);
  });

  it('updates an existing scene when the code changes', () => {
    const previous = {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE,
      included: true
    };

    const { scene, changed } = applyLearnedScene(previous, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: ['ddd', 'eee']
    });

    assert.equal(changed, true);
    assert.deepEqual(scene.code, ['ddd', 'eee']);
    assert.equal(scene.included, true);
    assert.equal(scene.deviceId, HOUSE_ID);
  });

  it('keeps a previously stored deviceId when a later line has none', () => {
    const previous = {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE,
      included: true
    };

    const { scene, changed } = applyLearnedScene(previous, {
      deviceId: '',
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE
    });

    assert.equal(changed, false);
    assert.equal(scene.deviceId, HOUSE_ID);
  });

  it('attaches brightness without replacing the stored scene code', () => {
    const previous = {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE,
      included: true
    };

    const { scene, changed } = applyLearnedScene(previous, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      brightness: 40
    });

    assert.equal(changed, true);
    assert.equal(scene.brightness, 40);
    assert.deepEqual(scene.code, COMING_HOME_CODE);
  });

  it('does not rewind a newer recipe when an older log line is harvested', () => {
    const previous = {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Halloween',
      code: ['new-a', 'new-b'],
      brightness: 25,
      included: true,
      lastSeen: '2026-09-27T21:51:59.000Z'
    };

    const { scene, changed } = applyLearnedScene(previous, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Halloween',
      code: ['old-a'],
      brightness: 100,
      lastSeen: '2026-09-27T19:24:13.000Z'
    });

    assert.equal(changed, false);
    assert.deepEqual(scene.code, ['new-a', 'new-b']);
    assert.equal(scene.brightness, 25);
  });
});

describe('association helpers', () => {
  it('marks an ignoreDevices name as excluded when an init line is learned', () => {
    const { device } = associateDeviceName({
      id: GARAGE_ID,
      ip: '192.168.1.10',
      sku: 'H6173',
      included: false
    }, {
      name: 'Garage Door LightStrip',
      sku: 'H6173'
    }, {
      ignoreDevices: legacyConfig.ignoreDevices
    });

    assert.equal(device.name, 'Garage Door LightStrip');
    assert.equal(device.included, false);
  });

  it('backfills a scene that was stored before the device id was known', () => {
    const { scenes, changed } = backfillSceneDeviceIds([{
      deviceId: '',
      deviceName: 'Garage Door LightStrip',
      sceneName: 'HomeBridge Test',
      code: ['xyz'],
      included: true
    }], 'Garage Door LightStrip', GARAGE_ID);

    assert.equal(changed, true);
    assert.equal(scenes[0].deviceId, GARAGE_ID);
    assert.equal(scenes[0].included, true);
  });
});

describe('parseGoveeLine', () => {
  it('parses a trustworthy initialised-with-id line', () => {
    const parsed = parseGoveeLine(
      '[Govee] [Garage Door LightStrip] initialised with id [9A:00:00:00:00:00:00:02] [H6173].'
    );

    assert.deepEqual(parsed, {
      type: 'init',
      name: 'Garage Door LightStrip',
      id: GARAGE_ID,
      sku: 'H6173'
    });
  });

  it('parses an ANSI-colored Tap-to-Run AWS scene line', () => {
    const parsed = parseGoveeLine(
      '\x1B[37m[9/24/2026, 5:31:15 PM]\x1B[39m \x1B[36m[Govee]\x1B[39m [House Lights] [Coming Home] [AWS] aaa,bbb,ccc'
    );

    assert.deepEqual(parsed, {
      type: 'scene',
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: COMING_HOME_CODE
    });
  });

  it('ignores AWS status lines that are not Tap-to-Run scenes', () => {
    assert.equal(parseGoveeLine(
      '[Govee] [Garage Door LightStrip] [AWS] receiving update {"device":"x"}'
    ), null);
  });

  it('parses brightness from a Tap-to-Run rule debug line', () => {
    const parsed = parseGoveeLine(
      '[Govee] [Garage Door LightStrip] [HomeBridge Test] ttr rule debug: {"cmdType":1,"deviceType":2,"cmdVal":"{\\"brightness\\":50}","iotMsg":"{\\"msg\\":{\\"cmd\\":\\"brightness\\",\\"data\\":{\\"val\\":50}}}","blueMsg":"{}","effect":null}.'
    );

    assert.deepEqual(parsed, {
      type: 'brightness',
      deviceName: 'Garage Door LightStrip',
      sceneName: 'HomeBridge Test',
      brightness: 50
    });
  });

  it('ignores non-brightness Tap-to-Run rule debug lines', () => {
    assert.equal(parseGoveeLine(
      '[Govee] [House Lights] [Coming Home] ttr rule debug: {"cmdType":0,"cmdVal":"{\\"open\\":1}","iotMsg":"{\\"msg\\":{\\"cmd\\":\\"turn\\",\\"data\\":{\\"val\\":1}}}"}.'
    ), null);
  });
});

const liveDevices = {
  [GARAGE_ID]: {
    id: GARAGE_ID,
    name: 'Garage Door LightStrip',
    sku: 'H6173',
    ip: '192.168.1.10',
    included: false
  },
  [HOUSE_ID]: {
    id: HOUSE_ID,
    name: 'House Lights',
    sku: 'H706A',
    ip: '192.168.1.20',
    included: true
  }
};

const comingHome = {
  deviceId: HOUSE_ID,
  deviceName: 'House Lights',
  sceneName: 'Coming Home',
  code: COMING_HOME_CODE,
  included: true
};

const homebridgeTest = {
  deviceId: GARAGE_ID,
  deviceName: 'Garage Door LightStrip',
  sceneName: 'HomeBridge Test',
  code: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  included: true
};

const unresolvedScene = {
  deviceId: '',
  deviceName: 'Office Downlight 01',
  sceneName: 'Ignored Device Test',
  code: Array(11).fill('x'),
  included: true
};

function plan(scenes, devices, ignoreDevices = [], cachedUUIDs = []) {
  return planAccessoryReconciliation({
    scenes,
    devices,
    ignoreDevices,
    cachedUUIDs,
    uuidFor: scene => accessoryUUIDSource(scene.deviceId, scene.sceneName)
  });
}

describe('planAccessoryReconciliation', () => {
  it('desires an included device plus included associated scene', () => {
    const result = plan([comingHome], liveDevices, legacyConfig.ignoreDevices);

    assert.deepEqual(result.desired.map(item => item.scene.sceneName), ['Coming Home']);
    assert.equal(
      result.desired[0].uuid,
      accessoryUUIDSource(HOUSE_ID, 'Coming Home')
    );
  });

  it('does not desire an included scene on an excluded device', () => {
    const result = plan([homebridgeTest], liveDevices, []);

    assert.equal(homebridgeTest.included, true);
    assert.deepEqual(result.desired, []);
  });

  it('does not desire an excluded scene on an included device', () => {
    const excluded = { ...comingHome, included: false };
    const result = plan([excluded], liveDevices, []);

    assert.deepEqual(result.desired, []);
  });

  it('does not desire an unresolved scene', () => {
    const result = plan([unresolvedScene], liveDevices, legacyConfig.ignoreDevices);

    assert.equal(unresolvedScene.included, true);
    assert.deepEqual(result.desired, []);
  });

  it('desires an included device even if its name is still in ignoreDevices', () => {
    const devices = {
      ...liveDevices,
      [GARAGE_ID]: { ...liveDevices[GARAGE_ID], included: true }
    };
    const result = plan([homebridgeTest], devices, legacyConfig.ignoreDevices);

    assert.equal(homebridgeTest.included, true);
    assert.equal(result.desired.length, 1);
    assert.equal(result.desired[0].scene.sceneName, 'HomeBridge Test');
  });

  it('still desires an offline but associated included device', () => {
    const devices = {
      ...liveDevices,
      [HOUSE_ID]: { ...liveDevices[HOUSE_ID], ip: undefined }
    };
    const result = plan([comingHome], devices, []);

    assert.equal(result.desired.length, 1);
    assert.equal(result.desired[0].scene.sceneName, 'Coming Home');
  });

  it('does not change UUID when the scene code changes', () => {
    const updated = { ...comingHome, code: ['ddd', 'eee'] };
    const before = plan([comingHome], liveDevices, [])
      .desired[0].uuid;
    const after = plan([updated], liveDevices, [])
      .desired[0].uuid;

    assert.equal(after, before);
    assert.equal(after, accessoryUUIDSource(HOUSE_ID, 'Coming Home'));
  });

  it('does not change scene.included when the device is excluded', () => {
    const scene = { ...homebridgeTest };
    const devices = {
      ...liveDevices,
      [GARAGE_ID]: { ...liveDevices[GARAGE_ID], included: false }
    };
    const result = plan([scene], devices, []);

    assert.equal(scene.included, true);
    assert.deepEqual(result.desired, []);
  });

  it('makes previously included scenes desired again after device re-inclusion', () => {
    const scene = { ...homebridgeTest };
    const excluded = plan([scene], {
      ...liveDevices,
      [GARAGE_ID]: { ...liveDevices[GARAGE_ID], included: false }
    }, []);
    const included = plan([scene], {
      ...liveDevices,
      [GARAGE_ID]: { ...liveDevices[GARAGE_ID], included: true }
    }, []);

    assert.equal(scene.included, true);
    assert.deepEqual(excluded.desired, []);
    assert.equal(included.desired.length, 1);
    assert.equal(included.desired[0].scene.sceneName, 'HomeBridge Test');
  });

  it('keeps Coming Home, registers nothing extra, and marks stale accessories', () => {
    const comingHomeUuid = accessoryUUIDSource(HOUSE_ID, 'Coming Home');
    const staleUuid = accessoryUUIDSource(GARAGE_ID, 'HomeBridge Test');
    const result = plan(
      [comingHome, homebridgeTest, unresolvedScene],
      liveDevices,
      legacyConfig.ignoreDevices,
      [comingHomeUuid, staleUuid]
    );

    assert.deepEqual(result.keep.map(item => item.uuid), [comingHomeUuid]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.staleUUIDs, [staleUuid]);
  });
});
