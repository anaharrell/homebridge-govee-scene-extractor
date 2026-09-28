const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const {
  accessoryUUIDSource,
  applyLanDevice,
  applyLearnedScene,
  associateDeviceName,
  backfillSceneDeviceIds,
  buildAssociations,
  hasDeviceId,
  editSnapshot,
  applyDiskEdits,
  clearTombstone,
  parseHomebridgeTime,
  shouldSkipDeleted,
  migrateState,
  parseGoveeConfiguredDevices,
  resolvePluginStateDir,
  sameSceneRow,
  ttrOwners,
  ttrSendTargets,
  parseGoveeLine,
  planAccessoryReconciliation,
  resolveDeviceId,
  sceneKey,
  shouldPublish,
  stripAnsi
} = require('./lib/state');
const {
  extractTtrBrightness,
  fetchTtrComponents,
  goveeClientId,
  goveeUsernameFromConfig,
  readCachedTtrToken
} = require('./lib/ttr-http');

const PN = 'homebridge-govee-scene-extractor';
const PL = 'GoveeSceneExtractor';

class GoveeSceneExtractor {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.acc = new Map();

    if (!log || !config || !api)
      return;

    this.S = api.hap.Service;
    this.C = api.hap.Characteristic;

    this.logPath = this.config.logPath ||
      path.join(api.user.storagePath(), 'homebridge.log');

    this.resetAfterMs = Number(this.config.resetAfterMs || 1000);
    this.ignore = new Set(this.config.ignoreDevices || []);
    this.deviceMap = this.config.deviceMap || {};

    this.devices = new Map();
    this.scenes = new Map();
    this.missingIdWarned = new Set();

    this.dir = resolvePluginStateDir(api.user.storagePath());
    this.file = path.join(this.dir, 'state.json');

    this.offset = 0;
    this.partial = '';
    this.poller = null;
    this.scanSocket = null;
    this.scanStartTimer = null;
    this.scanRetryTimer = null;
    this.scanCloseTimer = null;
    this.stateMtimeMs = 0;
    this.lastEdit = '';
    this.deletedScenes = [];
    this.configured = [];
    this.ttrRefreshBusy = false;

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(a) {
    if (!this.acc)
      return;

    this.acc.set(a.UUID, a);
  }

  key(device, scene) {
    return sceneKey(device, scene);
  }

  associations() {
    return buildAssociations({
      deviceMap: this.deviceMap,
      devices: [...this.devices.values()],
      scenes: [...this.scenes.values()],
      configured: this.configured
    });
  }

  canPublish(scene) {
    return shouldPublish(scene, {
      devices: Object.fromEntries(this.devices),
      ignoreDevices: [...this.ignore]
    });
  }

  load() {
    try {
      const x = JSON.parse(fs.readFileSync(this.file, 'utf8'));

      for (const d of x.devices || [])
        this.devices.set(d.id, d);

      for (const s of x.scenes || [])
        this.scenes.set(this.key(s.deviceName, s.sceneName), s);

      this.deletedScenes = x.deletedScenes || [];

    } catch (e) {
      if (e.code !== 'ENOENT')
        this.log.warn(`State load: ${e.message}`);
    }
  }

  migrate() {
    const migrated = migrateState({
      devices: [...this.devices.values()],
      scenes: [...this.scenes.values()]
    }, {
      deviceMap: this.deviceMap,
      ignoreDevices: [...this.ignore],
      configured: this.configured
    });

    this.devices = new Map(
      migrated.devices.filter(d => d.id).map(d => [d.id, d])
    );

    this.scenes = new Map(
      migrated.scenes.map(s => [this.key(s.deviceName, s.sceneName), s])
    );
    this.deletedScenes = migrated.deletedScenes || this.deletedScenes;

    return migrated;
  }

  adopt(devices, scenes, deletedScenes) {
    this.devices = new Map(
      devices.filter(d => d.id).map(d => [d.id, d])
    );
    this.scenes = new Map(
      scenes.map(s => [this.key(s.deviceName, s.sceneName), s])
    );
    if (deletedScenes)
      this.deletedScenes = deletedScenes;
  }

  currentState() {
    return {
      devices: [...this.devices.values()],
      scenes: [...this.scenes.values()],
      deletedScenes: this.deletedScenes
    };
  }

  rememberStateFile() {
    try {
      this.stateMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (_) {
      this.stateMtimeMs = 0;
    }

    this.lastEdit = editSnapshot(this.currentState());
  }

  mergeDiskEdits() {
    try {
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const merged = applyDiskEdits(this.currentState(), disk);

      if (merged.changed)
        this.adopt(merged.devices, merged.scenes, merged.deletedScenes);

      return merged.changed;
    } catch (e) {
      if (e.code !== 'ENOENT')
        this.log.debug(`State merge: ${e.message}`);

      return false;
    }
  }

  reloadStateIfChanged() {
    try {
      const st = fs.statSync(this.file);

      if (st.mtimeMs === this.stateMtimeMs)
        return;

      this.stateMtimeMs = st.mtimeMs;
      const disk = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const snap = editSnapshot(disk);

      if (snap === this.lastEdit)
        return;

      const merged = applyDiskEdits(this.currentState(), disk);

      if (!merged.changed) {
        this.lastEdit = snap;
        return;
      }

      this.adopt(merged.devices, merged.scenes, merged.deletedScenes);
      this.lastEdit = editSnapshot(this.currentState());
      this.log.info('Updated settings from plugin UI.');
      this.reconcileAccessories();
    } catch (e) {
      if (e.code !== 'ENOENT')
        this.log.debug(`State reload: ${e.message}`);
    }
  }

  save() {
    this.mergeDiskEdits();
    fs.mkdirSync(this.dir, { recursive: true });

    const tmp = this.file + '.tmp';

    fs.writeFileSync(tmp, JSON.stringify({
      devices: [...this.devices.values()],
      scenes: [...this.scenes.values()],
      deletedScenes: this.deletedScenes
    }, null, 2));

    fs.renameSync(tmp, this.file);
    this.rememberStateFile();
  }

  snapshot() {
    return JSON.stringify({
      devices: [...this.devices.values()],
      scenes: [...this.scenes.values()],
      deletedScenes: this.deletedScenes
    });
  }

  start() {
    this.loadConfiguredDevices();
    this.load();
    const before = this.snapshot();
    this.migrate();
    this.applyConfiguredAssociations();
    if (before !== this.snapshot())
      this.save();

    // Harvest existing Govee scene lines once at startup.
    try {
      const existing = fs.readFileSync(this.logPath, 'utf8');

      for (const line of existing.split(/\r?\n/))
        this.parse(line, { reconcile: false });

      // Begin live polling from the current end of the file.
      this.offset = fs.statSync(this.logPath).size;
      this.partial = '';

    } catch (e) {
      this.log.warn(`Initial log harvest: ${e.message}`);
    }

    this.reconcileAccessories();
    this.rememberStateFile();
    this.refreshTtrBrightness();

    this.poller = setInterval(() => {
      this.read();
      this.reloadStateIfChanged();
    }, 1000);
    this.poller.unref?.();

    // Let the regular Govee child bridge finish LAN discovery first.
    // Learned device addresses are persisted, so scene switches can
    // operate immediately while this refresh happens in the background.
    this.scanStartTimer = setTimeout(
      () => this.discoverLAN(),
      10000
    );
    this.scanStartTimer.unref?.();

    this.log.info(`Watching ${this.logPath}`);
  }

  stop() {
    if (this.poller)
      clearInterval(this.poller);

    if (this.scanStartTimer)
      clearTimeout(this.scanStartTimer);

    if (this.scanRetryTimer)
      clearTimeout(this.scanRetryTimer);

    if (this.scanCloseTimer)
      clearTimeout(this.scanCloseTimer);

    this.closeScanSocket();
  }

  closeScanSocket() {
    if (!this.scanSocket)
      return;

    const socket = this.scanSocket;
    this.scanSocket = null;

    try {
      socket.close();
    } catch (_) {}
  }

  discoverLAN() {
    if (this.scanSocket)
      return;

    const socket = dgram.createSocket({
      type: 'udp4',
      reuseAddr: true
    });

    this.scanSocket = socket;

    socket.on('error', e =>
      this.log.warn(`LAN discovery: ${e.message}`)
    );

    socket.on('message', (buf, rinfo) => {
      try {
        const x = JSON.parse(buf.toString());

        if (x?.msg?.cmd !== 'scan')
          return;

        const d = x.msg.data || {};

        const id = d.device;
        const ip = d.ip || rinfo.address;

        if (!id || !ip)
          return;

        const old = this.devices.get(id) || {};
        const name = old.name || this.associations().idToName[id];
        const { device, changed } = applyLanDevice(old, {
          id,
          ip,
          sku: d.sku,
          name
        }, {
          ignoreDevices: [...this.ignore]
        });

        if (changed) {
          this.devices.set(id, device);
          this.save();

          this.log.info(
            `Discovered Govee LAN device ${id} [${device.sku || 'unknown'}] at ${ip}`
          );

          this.reconcileAccessories();
        }

      } catch (_) {}
    });

    socket.bind(4002, () => {
      try {
        socket.addMembership('239.255.255.250');
      } catch (_) {}

      socket.setBroadcast(true);

      const msg = Buffer.from(JSON.stringify({
        msg: {
          cmd: 'scan',
          data: {
            account_topic: 'reserve'
          }
        }
      }));

      socket.send(
        msg,
        4001,
        '239.255.255.250',
        e => {
          if (e)
            this.log.warn(`LAN scan send: ${e.message}`);
          else
            this.log.info('Govee LAN scan sent.');
        }
      );

      this.scanRetryTimer = setTimeout(() => {
        this.scanRetryTimer = null;
        try {
          socket.send(
            msg,
            4001,
            '239.255.255.250'
          );
        } catch (_) {}
      }, 1500);
      this.scanRetryTimer.unref?.();

      // Release UDP 4002 after a short discovery window.
      this.scanCloseTimer = setTimeout(() => {
        this.scanCloseTimer = null;
        this.closeScanSocket();
        this.log.debug('Govee LAN discovery window closed.');
      }, 4000);

      this.scanCloseTimer.unref?.();
    });
  }

  read() {
    let fd;

    try {
      const st = fs.statSync(this.logPath);

      if (st.size < this.offset) {
        this.offset = 0;
        this.partial = '';
      }

      if (st.size === this.offset)
        return;

      fd = fs.openSync(this.logPath, 'r');

      const b = Buffer.alloc(st.size - this.offset);

      fs.readSync(
        fd,
        b,
        0,
        b.length,
        this.offset
      );

      this.offset = st.size;

      const lines =
        (this.partial + b.toString()).split(/\r?\n/);

      this.partial = lines.pop() || '';

      for (const line of lines)
        this.parse(line);

    } catch (e) {
      this.log.debug(`Log read: ${e.message}`);

    } finally {
      if (fd !== undefined)
        fs.closeSync(fd);
    }
  }

  parse(line, { reconcile = true } = {}) {
    const parsed = parseGoveeLine(line);

    if (!parsed) {
      if (
        reconcile &&
        stripAnsi(line).includes('[Govee] ✓ Setup complete')
      )
        this.refreshTtrBrightness();
      return;
    }

    if (parsed.type === 'init') {
      this.learnAssociation(parsed, { reconcile });
      return;
    }

    if (parsed.type !== 'scene' && parsed.type !== 'brightness')
      return;

    const { deviceName, sceneName, code, brightness } = parsed;
    const seenAt = parseHomebridgeTime(line);

    if (shouldSkipDeleted(this.deletedScenes, deviceName, sceneName, seenAt))
      return;

    if (this.deletedScenes.length) {
      const before = this.deletedScenes.length;
      this.deletedScenes = clearTombstone(
        this.deletedScenes,
        deviceName,
        sceneName
      );
      if (this.deletedScenes.length !== before)
        this.log.info(
          `Rediscovered scene: ${deviceName} / ${sceneName}`
        );
    }

    const id = resolveDeviceId(
      deviceName,
      this.associations(),
      this.deviceMap[deviceName]
    );
    const sceneKeyValue = this.key(deviceName, sceneName);
    const previous = this.scenes.get(sceneKeyValue);
    const { scene, changed, touch } = applyLearnedScene(previous, {
      deviceId: id,
      deviceName,
      sceneName,
      code,
      brightness,
      lastSeen: seenAt
    });

    if (!changed)
      return;

    this.scenes.set(sceneKeyValue, scene);
    this.save();

    if (touch)
      return;

    if (!hasDeviceId(scene.deviceId) && !this.missingIdWarned.has(deviceName)) {
      this.missingIdWarned.add(deviceName);
      this.log.warn(
        `Scene "${sceneName}" found for "${deviceName}", but no device id association yet; stored without publishing.`
      );
    }

    const owner = ttrOwners(
      [...this.scenes.values()],
      Object.fromEntries(this.devices)
    ).get(sceneName);
    const note = !owner
      ? '; not publishing.'
      : sameSceneRow(owner, scene)
        ? ''
        : '; linked, one HomeKit switch.';

    const brightNote = Number.isInteger(scene.brightness)
      ? ` (${scene.brightness}%)`
      : '';

    this.log.info(
      `${previous ? 'Updated' : 'Learned'} scene: ${deviceName} / ${sceneName}` +
      brightNote +
      note
    );

    if (reconcile)
      this.reconcileAccessories();
  }

  loadConfiguredDevices() {
    try {
      this.configured = parseGoveeConfiguredDevices(
        JSON.parse(fs.readFileSync(this.api.user.configPath(), 'utf8'))
      );
    } catch (e) {
      this.configured = [];
      this.log.warn(`Stock Govee config: ${e.message}`);
    }
  }

  applyConfiguredAssociations() {
    for (const [name, id] of Object.entries(this.deviceMap))
      this.learnAssociation({ name, id }, { reconcile: false });

    for (const item of this.configured) {
      this.learnAssociation({
        name: item.name,
        id: item.id
      }, {
        reconcile: false,
        includedDefault: item.ignored ? false : undefined
      });
    }
  }

  learnAssociation({ name, id, sku }, {
    reconcile = true,
    includedDefault
  } = {}) {
    if (!name || !hasDeviceId(id))
      return;

    const old = this.devices.get(id) || { id };
    const { device, changed: deviceChanged } = associateDeviceName(old, {
      name,
      sku
    }, {
      ignoreDevices: [...this.ignore],
      includedDefault
    });

    let changed = deviceChanged;
    this.devices.set(id, device);

    const backfilled = backfillSceneDeviceIds(
      [...this.scenes.values()],
      name,
      id
    );

    if (backfilled.changed) {
      changed = true;
      this.scenes = new Map(
        backfilled.scenes.map(s => [this.key(s.deviceName, s.sceneName), s])
      );
    }

    if (changed) {
      if (!old.name && device.name)
        this.log.info(`Associated device: ${device.name}`);

      this.save();
      if (reconcile)
        this.reconcileAccessories();
    }
  }

  reconcileAccessories() {
    const plan = planAccessoryReconciliation({
      scenes: [...this.scenes.values()],
      devices: Object.fromEntries(this.devices),
      ignoreDevices: [...this.ignore],
      cachedUUIDs: [...this.acc.keys()],
      uuidFor: scene => this.api.hap.uuid.generate(
        accessoryUUIDSource(scene.deviceId, scene.sceneName)
      )
    });

    for (const uuid of plan.staleUUIDs) {
      const accessory = this.acc.get(uuid);
      if (!accessory)
        continue;

      this.api.unregisterPlatformAccessories(PN, PL, [accessory]);
      this.acc.delete(uuid);
      this.log.info(
        `Removed HomeKit scene switch: ${accessory.displayName}`
      );
    }

    for (const { scene } of plan.desired)
      this.ensure(scene);
  }

  ensure(scene) {
    const uuid = this.api.hap.uuid.generate(
      accessoryUUIDSource(scene.deviceId, scene.sceneName)
    );

    let accessory = this.acc.get(uuid);

    if (!accessory) {
      accessory =
        new this.api.platformAccessory(
          scene.sceneName,
          uuid
        );

      this.api.registerPlatformAccessories(
        PN,
        PL,
        [accessory]
      );

      this.acc.set(uuid, accessory);

      this.log.info(
        `Created HomeKit scene switch: ${scene.sceneName}`
      );
    }

    accessory.context.sceneKey =
      this.key(
        scene.deviceName,
        scene.sceneName
      );
    accessory.context.deviceId = scene.deviceId;
    accessory.context.sceneName = scene.sceneName;

    accessory
      .getService(this.S.AccessoryInformation)
      .setCharacteristic(
        this.C.Manufacturer,
        'Govee Scene Bridge'
      )
      .setCharacteristic(
        this.C.Model,
        'Local Govee Scene'
      );

    const service =
      accessory.getService(this.S.Switch) ||
      accessory.addService(
        this.S.Switch,
        scene.sceneName
      );

    const characteristic =
      service.getCharacteristic(this.C.On);

    characteristic.removeAllListeners('get');
    characteristic.removeAllListeners('set');

    characteristic
      .onGet(() => false)
      .onSet(async value => {
        if (!value)
          return;

        try {
          await this.sendTapToRun(accessory.context.sceneName);
        } catch (e) {
          this.log.warn(`Scene send failed: ${e.message}`);
          throw e;
        } finally {
          setTimeout(() => {
            service.updateCharacteristic(
              this.C.On,
              false
            );
          }, this.resetAfterMs);
        }
      });
  }

  async refreshTtrBrightness() {
    if (this.ttrRefreshBusy)
      return;

    this.ttrRefreshBusy = true;

    try {
      let config = {};
      try {
        config = JSON.parse(
          fs.readFileSync(this.api.user.configPath(), 'utf8')
        );
      } catch (_) {}

      const token = readCachedTtrToken(this.api.user.storagePath());
      const username = goveeUsernameFromConfig(config);
      const clientId = goveeClientId(
        username,
        this.api.hap.uuid.generate.bind(this.api.hap.uuid)
      );
      const components = await fetchTtrComponents({ token, clientId });
      const rows = extractTtrBrightness(components);
      let changed = 0;

      for (const row of rows) {
        const key = this.key(row.deviceName, row.sceneName);
        const previous = this.scenes.get(key);
        if (!previous)
          continue;

        const learned = applyLearnedScene(previous, {
          deviceId: previous.deviceId,
          deviceName: row.deviceName,
          sceneName: row.sceneName,
          brightness: row.brightness
        });

        if (!learned.changed || learned.touch)
          continue;

        this.scenes.set(key, learned.scene);
        changed += 1;
        this.log.info(
          `TTR brightness: ${row.deviceName} / ${row.sceneName} (${row.brightness}%)`
        );
      }

      if (changed)
        this.save();
    } catch (e) {
      this.log.debug(`TTR brightness refresh: ${e.message}`);
    } finally {
      this.ttrRefreshBusy = false;
    }
  }

  async sendTapToRun(sceneName) {
    const members = [...this.scenes.values()]
      .filter(scene => scene.sceneName === sceneName);
    const devices = Object.fromEntries(this.devices);
    const targets = ttrSendTargets(members, devices);

    if (!targets.length)
      throw Error(`No LAN targets for ${sceneName}`);

    const errors = [];

    for (const scene of targets) {
      try {
        await this.send(scene);
      } catch (e) {
        errors.push(`${scene.deviceName}: ${e.message}`);
      }
    }

    if (errors.length === targets.length)
      throw Error(errors.join('; '));

    if (errors.length)
      this.log.warn(`Scene send partial: ${errors.join('; ')}`);
  }

  sendLan(ip, cmd, data) {
    const payload = Buffer.from(JSON.stringify({
      msg: { cmd, data }
    }));

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');

      socket.send(payload, 4003, ip, error => {
        socket.close();

        if (error)
          reject(error);
        else
          resolve();
      });
    });
  }

  async send(scene) {
    const device =
      this.devices.get(scene.deviceId);

    if (!device?.ip)
      throw Error(
        `No LAN IP for ${scene.deviceName}`
      );

    await this.sendLan(device.ip, 'turn', { value: 1 });

    if (Number.isInteger(scene.brightness)) {
      await new Promise(resolve => setTimeout(resolve, 150));
      await this.sendLan(device.ip, 'brightness', {
        value: scene.brightness
      });
    }

    await new Promise(resolve => setTimeout(resolve, 150));
    await this.sendLan(device.ip, 'ptReal', {
      command: scene.code
    });

    this.log.info(
      `Sent "${scene.sceneName}" to ${scene.deviceName} over LAN` +
      (Number.isInteger(scene.brightness)
        ? ` at ${scene.brightness}%.`
        : '.')
    );
  }
}

function register(api) {
  api.registerPlatform(PN, PL, GoveeSceneExtractor);
}

register.GoveeSceneExtractor = GoveeSceneExtractor;
module.exports = register;
