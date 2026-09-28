'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  accessoryUUIDSource,
  buildUiState,
  planAccessoryReconciliation,
  ttrSendTargets
} = require('../lib/state');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const GARAGE_ID = '9A:00:00:00:00:00:00:02';

const devices = {
  [HOUSE_ID]: {
    id: HOUSE_ID,
    name: 'House Lights',
    sku: 'H706A',
    ip: '192.168.1.20',
    included: true
  },
  [GARAGE_ID]: {
    id: GARAGE_ID,
    name: 'Garage Door LightStrip',
    sku: 'H6173',
    ip: '192.168.1.10',
    included: false
  }
};

const houseComingHome = {
  deviceId: HOUSE_ID,
  deviceName: 'House Lights',
  sceneName: 'Coming Home',
  code: ['aaa', 'bbb', 'ccc'],
  included: true
};

const garageComingHome = {
  deviceId: GARAGE_ID,
  deviceName: 'Garage Door LightStrip',
  sceneName: 'Coming Home',
  code: ['zzz'],
  included: true
};

function plan(scenes, deviceMap = devices, cachedUUIDs = []) {
  return planAccessoryReconciliation({
    scenes,
    devices: deviceMap,
    cachedUUIDs,
    uuidFor: scene => accessoryUUIDSource(scene.deviceId, scene.sceneName)
  });
}

describe('multi-device TTR', () => {
  it('publishes one Coming Home switch using the House Lights UUID', () => {
    const houseUuid = accessoryUUIDSource(HOUSE_ID, 'Coming Home');
    const result = plan(
      [houseComingHome, garageComingHome],
      devices,
      [houseUuid]
    );

    assert.equal(result.desired.length, 1);
    assert.equal(result.desired[0].uuid, houseUuid);
    assert.deepEqual(result.staleUUIDs, []);
  });

  it('does not create a second HomeKit switch when both devices are included', () => {
    const both = {
      ...devices,
      [GARAGE_ID]: { ...devices[GARAGE_ID], included: true }
    };
    const houseUuid = accessoryUUIDSource(HOUSE_ID, 'Coming Home');
    const result = plan(
      [houseComingHome, garageComingHome],
      both,
      [houseUuid]
    );

    assert.equal(result.desired.length, 1);
    assert.equal(result.desired[0].uuid, houseUuid);
  });

  it('sends to every linked device that has an IP, even if the device is excluded', () => {
    const targets = ttrSendTargets(
      [houseComingHome, garageComingHome],
      devices
    );

    assert.deepEqual(
      targets.map(scene => scene.deviceName).sort(),
      ['Garage Door LightStrip', 'House Lights']
    );
  });

  it('does not send a brightness-only stub with no scene code', () => {
    const targets = ttrSendTargets([
      houseComingHome,
      { ...garageComingHome, code: [] }
    ], devices);

    assert.deepEqual(targets.map(scene => scene.deviceName), ['House Lights']);
  });

  it('skips a linked recipe the user unchecked', () => {
    const targets = ttrSendTargets([
      houseComingHome,
      { ...garageComingHome, included: false }
    ], devices);

    assert.deepEqual(targets.map(scene => scene.deviceName), ['House Lights']);
  });

  it('marks linked scenes in the UI', () => {
    const ui = buildUiState({
      devices: Object.values(devices),
      scenes: [houseComingHome, garageComingHome]
    });
    const house = ui.devices.find(item => item.name === 'House Lights')
      .scenes.find(item => item.sceneName === 'Coming Home');
    const garage = ui.devices.find(item => item.name === 'Garage Door LightStrip')
      .scenes.find(item => item.sceneName === 'Coming Home');

    assert.deepEqual(house.linkedDevices, ['Garage Door LightStrip']);
    assert.equal(house.published, true);
    assert.equal(house.ttrPublished, true);
    assert.equal(house.switchOwner, 'House Lights');
    assert.deepEqual(garage.linkedDevices, ['House Lights']);
    assert.equal(garage.published, false);
    assert.equal(garage.ttrPublished, true);
    assert.equal(garage.switchOwner, 'House Lights');
  });

  it('still marks only one HomeKit owner when both devices are included', () => {
    const both = [
      { ...devices[HOUSE_ID] },
      { ...devices[GARAGE_ID], included: true }
    ];
    const ui = buildUiState({
      devices: both,
      scenes: [houseComingHome, garageComingHome]
    });
    const house = ui.devices.find(item => item.name === 'House Lights')
      .scenes.find(item => item.sceneName === 'Coming Home');
    const garage = ui.devices.find(item => item.name === 'Garage Door LightStrip')
      .scenes.find(item => item.sceneName === 'Coming Home');
    const published = [house, garage].filter(item => item.published);

    assert.equal(published.length, 1);
    assert.equal(house.published, true);
    assert.equal(garage.published, false);
    assert.equal(house.ttrPublished, true);
    assert.equal(garage.ttrPublished, true);
  });

  it('names the one HomeKit owner on every linked device when three share a TTR', () => {
    const officeId = '01:00:00:00:00:00:00:03';
    const officeComingHome = {
      deviceId: officeId,
      deviceName: 'Office Downlight 01',
      sceneName: 'Coming Home',
      code: ['yyy'],
      included: true
    };
    const ui = buildUiState({
      devices: [
        ...Object.values(devices),
        {
          id: officeId,
          name: 'Office Downlight 01',
          ip: '192.168.1.30',
          included: false
        }
      ],
      scenes: [houseComingHome, garageComingHome, officeComingHome]
    });
    const rows = ui.devices.flatMap(item => item.scenes)
      .filter(item => item.sceneName === 'Coming Home');
    const owners = rows.filter(item => item.published);
    const linked = rows.filter(item => !item.published);

    assert.equal(owners.length, 1);
    assert.equal(owners[0].deviceName, 'House Lights');
    assert.deepEqual(linked.map(item => item.switchOwner), [
      'House Lights',
      'House Lights'
    ]);
  });
});
