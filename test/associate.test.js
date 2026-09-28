'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  accessoryUUIDSource,
  applyLearnedScene,
  associateDeviceName,
  backfillSceneDeviceIds,
  buildAssociations,
  buildUiState,
  parseGoveeConfiguredDevices,
  shouldPublish
} = require('../lib/state');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const OFFICE_ID = '11:00:00:00:00:00:00:0A';
const OTHER_ID = '99:00:00:00:00:00:00:99';

const goveeConfig = {
  platforms: [
    {
      platform: 'Govee',
      lightDevices: [
        { label: 'House Lights', deviceId: HOUSE_ID, ignoreDevice: true },
        { label: 'Office Downlight 01', deviceId: OFFICE_ID, ignoreDevice: true }
      ],
      thermoDevices: [{ openApiTempUnit: 'C' }]
    }
  ]
};

describe('parseGoveeConfiguredDevices', () => {
  it('reads label and id from stock Govee device lists, including ignored lights', () => {
    assert.deepEqual(parseGoveeConfiguredDevices(goveeConfig), [
      { name: 'House Lights', id: HOUSE_ID, ignored: true },
      { name: 'Office Downlight 01', id: OFFICE_ID, ignored: true }
    ]);
  });
});

describe('buildAssociations', () => {
  it('lets deviceMap win over a conflicting stock Govee label', () => {
    const { nameToId } = buildAssociations({
      deviceMap: { 'House Lights': HOUSE_ID },
      configured: [{ name: 'House Lights', id: OTHER_ID, ignored: true }]
    });

    assert.equal(nameToId['House Lights'], HOUSE_ID);
  });

  it('associates an ignored device from stock Govee config', () => {
    const { nameToId } = buildAssociations({
      configured: parseGoveeConfiguredDevices(goveeConfig)
    });

    assert.equal(nameToId['Office Downlight 01'], OFFICE_ID);
  });
});

describe('associateDeviceName from stock config', () => {
  it('creates an ignored configured device as excluded', () => {
    const { device } = associateDeviceName({ id: OFFICE_ID }, {
      name: 'Office Downlight 01'
    }, {
      includedDefault: false
    });

    assert.equal(device.name, 'Office Downlight 01');
    assert.equal(device.included, false);
  });

  it('does not change Coming Home inclusion when House Lights is already named', () => {
    const { device, changed } = associateDeviceName({
      id: HOUSE_ID,
      name: 'House Lights',
      included: true
    }, {
      name: 'House Lights'
    }, {
      includedDefault: false
    });

    assert.equal(changed, false);
    assert.equal(device.included, true);
  });

  it('does not rename a device from a conflicting label', () => {
    const { device, changed } = associateDeviceName({
      id: HOUSE_ID,
      name: 'House Lights',
      included: true
    }, {
      name: 'Office Downlight 01'
    });

    assert.equal(changed, false);
    assert.equal(device.name, 'House Lights');
  });
});

describe('ignored-device backfill', () => {
  it('attaches an id to a previously unresolved scene without publishing it', () => {
    const { scenes } = backfillSceneDeviceIds([{
      deviceId: '',
      deviceName: 'Office Downlight 01',
      sceneName: 'Ignored Device Test',
      code: ['aaa'],
      included: true
    }], 'Office Downlight 01', OFFICE_ID);

    const devices = {
      [OFFICE_ID]: {
        id: OFFICE_ID,
        name: 'Office Downlight 01',
        included: false
      }
    };

    assert.equal(scenes[0].deviceId, OFFICE_ID);
    assert.equal(shouldPublish(scenes[0], { devices }), false);

    const ui = buildUiState({
      devices: Object.values(devices),
      scenes: scenes
    });
    const office = ui.devices.find(item => item.name === 'Office Downlight 01');
    assert.equal(office.associated, true);
    assert.equal(office.included, false);
    assert.equal(office.scenes[0].associated, true);
    assert.equal(office.scenes[0].published, false);
  });

  it('does not change the Coming Home UUID source', () => {
    const { scene } = applyLearnedScene(undefined, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: ['aaa', 'bbb', 'ccc']
    });

    assert.equal(
      accessoryUUIDSource(scene.deviceId, scene.sceneName),
      `govee-scene-extractor:${HOUSE_ID}:Coming Home`
    );
  });
});
