'use strict';

const { describe, it, after } = require('node:test');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pluginStateDir,
  resolvePluginStateDir
} = require('../lib/state');

describe('resolvePluginStateDir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'govee-scenes-path-'));

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses storagePath/govee-scene-extractor, not persist', () => {
    const dir = pluginStateDir(tmp);
    assert.equal(dir, path.join(tmp, 'govee-scene-extractor'));
    assert.equal(resolvePluginStateDir(tmp), dir);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.existsSync(path.join(tmp, 'persist')), false);
  });
});
