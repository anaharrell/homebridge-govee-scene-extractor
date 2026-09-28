'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyInclusionChange,
  buildUiState,
  mergeInclusion
} = require('../lib/state');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const GARAGE_ID = '9A:00:00:00:00:00:00:02';

const liveState = {
  devices: [
    {
      id: GARAGE_ID,
      name: 'Garage Door LightStrip',
      sku: 'H6173',
      ip: '192.168.1.10',
      included: false
    },
    {
      id: HOUSE_ID,
      name: 'House Lights',
      sku: 'H706A',
      ip: '192.168.1.20',
      included: true
    }
  ],
  scenes: [
    {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: ['aaa', 'bbb', 'ccc'],
      included: true
    },
    {
      deviceId: '',
      deviceName: 'Office Downlight 01',
      sceneName: 'Ignored Device Test',
      code: Array(11).fill('x'),
      included: true
    },
    {
      deviceId: GARAGE_ID,
      deviceName: 'Garage Door LightStrip',
      sceneName: 'HomeBridge Test',
      code: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      included: true
    }
  ]
};

describe('buildUiState', () => {
  it('lists devices and scenes without command codes', () => {
    const ui = buildUiState(liveState);
    const names = ui.devices.map(d => d.name);
    const house = ui.devices.find(d => d.name === 'House Lights');
    const garage = ui.devices.find(d => d.name === 'Garage Door LightStrip');
    const office = ui.devices.find(d => d.name === 'Office Downlight 01');

    assert.deepEqual(names, [
      'Garage Door LightStrip',
      'House Lights',
      'Office Downlight 01'
    ]);
    assert.equal(house.sku, 'H706A');
    assert.equal(house.included, true);
    assert.equal(house.scenes[0].sceneName, 'Coming Home');
    assert.equal(house.scenes[0].published, true);
    assert.equal(garage.included, false);
    assert.equal(garage.scenes[0].published, false);
    assert.equal(office.associated, false);
    assert.equal(office.scenes[0].published, false);
    assert.equal(JSON.stringify(ui).includes('aaa'), false);
    assert.equal(JSON.stringify(ui).includes(HOUSE_ID), false);
  });
});

describe('applyInclusionChange', () => {
  it('excludes a device without changing scene.included or codes', () => {
    const next = applyInclusionChange(liveState, {
      kind: 'device',
      name: 'House Lights',
      included: false
    });
    const house = next.devices.find(d => d.id === HOUSE_ID);
    const scene = next.scenes.find(s => s.sceneName === 'Coming Home');

    assert.equal(next.changed, true);
    assert.equal(house.included, false);
    assert.equal(scene.included, true);
    assert.deepEqual(scene.code, ['aaa', 'bbb', 'ccc']);
  });

  it('excludes one scene only', () => {
    const next = applyInclusionChange(liveState, {
      kind: 'scene',
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      included: false
    });
    const scene = next.scenes.find(s => s.sceneName === 'Coming Home');
    const other = next.scenes.find(s => s.sceneName === 'HomeBridge Test');

    assert.equal(scene.included, false);
    assert.equal(other.included, true);
  });
});

describe('mergeInclusion', () => {
  it('takes inclusion from disk and keeps in-memory scene codes', () => {
    const disk = applyInclusionChange(liveState, {
      kind: 'device',
      name: 'House Lights',
      included: false
    });
    const current = {
      devices: liveState.devices.map(d => ({ ...d })),
      scenes: liveState.scenes.map(s => ({
        ...s,
        code: s.sceneName === 'Coming Home' ? ['new'] : s.code
      }))
    };
    const merged = mergeInclusion(current, {
      devices: disk.devices,
      scenes: disk.scenes
    });
    const house = merged.devices.find(d => d.id === HOUSE_ID);
    const scene = merged.scenes.find(s => s.sceneName === 'Coming Home');

    assert.equal(merged.changed, true);
    assert.equal(house.included, false);
    assert.deepEqual(scene.code, ['new']);
    assert.equal(scene.included, true);
  });
});
