'use strict';

const fs = require('fs');
const path = require('path');
const {
  applyDeletedScene,
  applyInclusionChange,
  buildUiState,
  resolvePluginStateDir
} = require('../lib/state');

(async () => {
  const { HomebridgePluginUiServer, RequestError } =
    await import('@homebridge/plugin-ui-utils');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/state', this.getState.bind(this));
      this.onRequest('/included', this.setIncluded.bind(this));
      this.onRequest('/delete', this.deleteScene.bind(this));
      this.ready();
    }

    stateFile() {
      return path.join(
        resolvePluginStateDir(this.homebridgeStoragePath),
        'state.json'
      );
    }

    readState() {
      try {
        return JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT')
          return { devices: [], scenes: [], deletedScenes: [] };

        throw new RequestError(e.message, { status: 500 });
      }
    }

    writeState(state) {
      const file = this.stateFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        devices: state.devices || [],
        scenes: state.scenes || [],
        deletedScenes: state.deletedScenes || []
      }, null, 2));
      fs.renameSync(tmp, file);
    }

    async getState() {
      return buildUiState(this.readState());
    }

    async setIncluded(payload) {
      const next = applyInclusionChange(this.readState(), payload || {});

      if (next.changed)
        this.writeState(next);

      return buildUiState(next);
    }

    async deleteScene(payload) {
      const next = applyDeletedScene(this.readState(), payload || {});

      if (next.changed)
        this.writeState(next);

      return buildUiState(next);
    }
  }

  return new UiServer();
})();
