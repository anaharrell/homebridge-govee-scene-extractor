'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractTtrBrightness,
  brightnessFromRule
} = require('../lib/ttr-http');

describe('extractTtrBrightness', () => {
  it('reads brightness from cmdVal and iotMsg without keeping command codes', () => {
    const rows = extractTtrBrightness([
      {
        oneClicks: [
          {
            name: 'Halloween',
            iotRules: [
              {
                deviceObj: { name: 'House Lights', sku: 'H706A' },
                rule: [
                  { cmdVal: '{"open":1}' },
                  { cmdVal: '{"brightness":25}' },
                  {
                    iotMsg: JSON.stringify({
                      msg: { cmd: 'ptReal', data: { command: ['aaa'] } }
                    })
                  }
                ]
              },
              {
                deviceObj: { name: 'Garage Door LightStrip' },
                rule: [
                  {
                    iotMsg: JSON.stringify({
                      msg: { cmd: 'brightness', data: { val: 13 } }
                    })
                  }
                ]
              }
            ]
          }
        ]
      }
    ]);

    assert.deepEqual(rows, [
      {
        deviceName: 'House Lights',
        sceneName: 'Halloween',
        brightness: 25
      },
      {
        deviceName: 'Garage Door LightStrip',
        sceneName: 'Halloween',
        brightness: 13
      }
    ]);
    assert.equal(JSON.stringify(rows).includes('aaa'), false);
  });

  it('ignores rules that are not brightness', () => {
    assert.equal(brightnessFromRule({ cmdVal: '{"open":1}' }), undefined);
    assert.equal(brightnessFromRule({
      iotMsg: '{"msg":{"cmd":"turn","data":{"val":1}}}'
    }), undefined);
  });
});
