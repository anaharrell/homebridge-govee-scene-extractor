'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyDeletedScene,
  applyDiskEdits,
  applyLearnedScene,
  buildUiState,
  formatLastSeen,
  parseHomebridgeTime,
  shouldSkipDeleted
} = require('../lib/state');

const HOUSE_ID = '23:00:00:00:00:00:00:01';
const latest = '2026-09-25T19:58:50.000Z';
const yesterday = '2026-09-24T19:26:00.000Z';

describe('parseHomebridgeTime', () => {
  it('reads a Homebridge log timestamp', () => {
    assert.equal(
      parseHomebridgeTime('[9/25/2026, 3:58:50 PM] [Govee] [House Lights] [Coming Home] [AWS] aaa'),
      new Date('9/25/2026 3:58:50 PM').toISOString()
    );
  });
});

describe('formatLastSeen', () => {
  const now = new Date('2026-09-25T20:00:00');

  it('formats today and yesterday', () => {
    const today = new Date('2026-09-25T15:58:00').toISOString();
    const prior = new Date('2026-09-24T15:26:00').toISOString();

    assert.match(formatLastSeen(today, now), /^today at /);
    assert.match(formatLastSeen(prior, now), /^yesterday at /);
    assert.equal(formatLastSeen('', now), 'Unknown');
  });
});

describe('lastSeen and discovery status', () => {
  it('marks stale scenes as not seen in the latest discovery', () => {
    const ui = buildUiState({
      devices: [{
        id: HOUSE_ID,
        name: 'House Lights',
        sku: 'H706A',
        included: true
      }],
      scenes: [
        {
          deviceId: HOUSE_ID,
          deviceName: 'House Lights',
          sceneName: 'Coming Home',
          code: ['aaa'],
          included: true,
          lastSeen: latest
        },
        {
          deviceId: '',
          deviceName: 'Office Downlight 01',
          sceneName: 'Ignored Device Test',
          code: ['bbb'],
          included: true,
          lastSeen: yesterday
        }
      ]
    });
    const home = ui.devices.find(d => d.name === 'House Lights').scenes[0];
    const office = ui.devices.find(d => d.name === 'Office Downlight 01').scenes[0];

    assert.equal(home.inLatestDiscovery, true);
    assert.equal(home.discoveryStatus, 'Seen in latest discovery');
    assert.equal(office.inLatestDiscovery, false);
    assert.equal(office.discoveryStatus, 'Not seen in latest discovery');
    assert.match(office.lastSeenLabel, /yesterday|Sep/);
  });

  it('updates lastSeen on a duplicate historical line without changing the code', () => {
    const previous = {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: ['aaa'],
      included: true,
      lastSeen: yesterday
    };
    const { scene, changed, touch } = applyLearnedScene(previous, {
      deviceId: HOUSE_ID,
      deviceName: 'House Lights',
      sceneName: 'Coming Home',
      code: ['aaa'],
      lastSeen: latest
    });

    assert.equal(changed, true);
    assert.equal(touch, true);
    assert.equal(scene.lastSeen, latest);
    assert.deepEqual(scene.code, ['aaa']);
    assert.equal(scene.included, true);
  });
});

describe('deleted scenes', () => {
  it('removes a scene and keeps a tombstone', () => {
    const next = applyDeletedScene({
      devices: [{ id: HOUSE_ID, name: 'House Lights', included: true }],
      scenes: [{
        deviceId: HOUSE_ID,
        deviceName: 'House Lights',
        sceneName: 'Coming Home',
        code: ['aaa'],
        included: true,
        lastSeen: latest
      }],
      deletedScenes: []
    }, {
      deviceName: 'House Lights',
      sceneName: 'Coming Home'
    }, '2026-09-25T20:05:00.000Z');

    assert.equal(next.scenes.length, 0);
    assert.equal(next.deletedScenes.length, 1);
    assert.equal(next.deletedScenes[0].sceneName, 'Coming Home');
    assert.equal(next.devices[0].included, true);
  });

  it('ignores older log lines after delete and allows a newer rediscovery', () => {
    const deleted = [{
      deviceName: 'Office Downlight 01',
      sceneName: 'Ignored Device Test',
      deletedAt: '2026-09-25T20:00:00.000Z'
    }];

    assert.equal(shouldSkipDeleted(
      deleted,
      'Office Downlight 01',
      'Ignored Device Test',
      yesterday
    ), true);

    assert.equal(shouldSkipDeleted(
      deleted,
      'Office Downlight 01',
      'Ignored Device Test',
      '2026-09-25T20:10:00.000Z'
    ), false);
  });

  it('does not let a stale disk tombstone wipe a rediscovered scene', () => {
    const merged = applyDiskEdits({
      devices: [{ id: HOUSE_ID, name: 'House Lights', included: true }],
      scenes: [{
        deviceId: HOUSE_ID,
        deviceName: 'House Lights',
        sceneName: 'Coming Home',
        code: ['aaa'],
        included: true,
        lastSeen: '2026-09-25T20:10:00.000Z'
      }],
      deletedScenes: []
    }, {
      devices: [{ id: HOUSE_ID, name: 'House Lights', included: true }],
      scenes: [],
      deletedScenes: [{
        deviceName: 'House Lights',
        sceneName: 'Coming Home',
        deletedAt: '2026-09-25T20:00:00.000Z'
      }]
    });

    assert.equal(merged.scenes.length, 1);
    assert.equal(merged.scenes[0].sceneName, 'Coming Home');
  });
});
