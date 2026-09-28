'use strict';

const fs = require('fs');
const path = require('path');

const ANSI_RE = /\x1B\[[0-?]*[ -\/]*[@-~]/g;

function pluginStateDir(storagePath) {
  return path.join(storagePath, 'govee-scene-extractor');
}

// Do not store plugin state under HAP persist/. Dummy's node-persist
// expire sweep throws EISDIR if persist contains a subdirectory.
function resolvePluginStateDir(storagePath) {
  const dir = pluginStateDir(storagePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  return dir;
}

function stripAnsi(line) {
  return String(line || '').replace(ANSI_RE, '');
}

function sceneKey(deviceName, sceneName) {
  return `${deviceName}\0${sceneName}`;
}

function accessoryUUIDSource(deviceId, sceneName) {
  return `govee-scene-extractor:${deviceId}:${sceneName}`;
}

const LATEST_DISCOVERY_MS = 2 * 60 * 1000;

function sameCode(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function parseHomebridgeTime(line) {
  const match = stripAnsi(line).match(
    /\[(\d{1,2}\/\d{1,2}\/\d{4}), (\d{1,2}:\d{2}:\d{2} [AP]M)\]/i
  );

  if (!match)
    return '';

  const date = new Date(`${match[1]} ${match[2]}`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function newerIso(a, b) {
  if (!a)
    return b || '';
  if (!b)
    return a;

  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function latestDiscoveryAt(scenes = []) {
  let latest = '';

  for (const scene of scenes) {
    if (scene.lastSeen)
      latest = newerIso(latest, scene.lastSeen);
  }

  return latest;
}

function isInLatestDiscovery(lastSeen, latest, windowMs = LATEST_DISCOVERY_MS) {
  if (!lastSeen || !latest)
    return false;

  return Date.parse(latest) - Date.parse(lastSeen) <= windowMs;
}

function formatLastSeen(iso, now = new Date()) {
  if (!iso)
    return 'Unknown';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime()))
    return 'Unknown';

  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startToday - startThat) / 86400000);

  if (days === 0)
    return `today at ${time}`;
  if (days === 1)
    return `yesterday at ${time}`;

  return `${date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })} at ${time}`;
}

function deletedKey(item) {
  return sceneKey(item.deviceName, item.sceneName);
}

function findTombstone(deletedScenes, deviceName, sceneName) {
  return (deletedScenes || []).find(item =>
    item.deviceName === deviceName && item.sceneName === sceneName
  );
}

function shouldSkipDeleted(deletedScenes, deviceName, sceneName, seenAt) {
  const tomb = findTombstone(deletedScenes, deviceName, sceneName);

  if (!tomb)
    return false;

  if (!seenAt)
    return true;

  return Date.parse(seenAt) <= Date.parse(tomb.deletedAt);
}

function clearTombstone(deletedScenes, deviceName, sceneName) {
  return (deletedScenes || []).filter(item =>
    item.deviceName !== deviceName || item.sceneName !== sceneName
  );
}

function hasDeviceId(id) {
  return typeof id === 'string' && id.trim() !== '';
}

function parseGoveeConfiguredDevices(config = {}) {
  const found = [];

  for (const platform of config.platforms || []) {
    if (!platform || platform.platform !== 'Govee')
      continue;

    for (const value of Object.values(platform)) {
      if (!Array.isArray(value))
        continue;

      for (const item of value) {
        const name = item && item.label;
        const id = item && item.deviceId;

        if (!name || !hasDeviceId(id))
          continue;

        found.push({
          name,
          id: String(id).trim(),
          ignored: item.ignoreDevice === true
        });
      }
    }
  }

  return found;
}

function buildAssociations({
  deviceMap = {},
  devices = [],
  scenes = [],
  configured = []
} = {}) {
  const nameToId = {};
  const idToName = {};

  function add(name, id) {
    if (!name || !hasDeviceId(id))
      return;

    if (!nameToId[name])
      nameToId[name] = id;

    if (!idToName[id])
      idToName[id] = name;
  }

  for (const [name, id] of Object.entries(deviceMap || {}))
    add(name, id);

  for (const item of configured)
    add(item.name, item.id);

  for (const scene of scenes)
    add(scene.deviceName, scene.deviceId);

  for (const device of devices)
    add(device.name, device.id);

  return { nameToId, idToName };
}

function resolveDeviceId(deviceName, associations, fallbackId) {
  if (hasDeviceId(fallbackId))
    return fallbackId;

  return associations.nameToId[deviceName] || '';
}

function migrateState(state = {}, {
  deviceMap = {},
  ignoreDevices = [],
  configured = []
} = {}) {
  const ignore = new Set(ignoreDevices || []);
  const associations = buildAssociations({
    deviceMap,
    devices: state.devices || [],
    scenes: state.scenes || [],
    configured
  });

  const devices = (state.devices || []).map(device => {
    const name = device.name || associations.idToName[device.id] || '';
    const next = { ...device };

    if (name)
      next.name = name;

    if (next.included === undefined) {
      next.included = !!(name && !ignore.has(name));
    }

    return next;
  });

  const scenes = (state.scenes || []).map(scene => ({
    ...scene,
    included: scene.included === undefined ? true : scene.included
  }));

  return {
    devices,
    scenes,
    deletedScenes: state.deletedScenes || [],
    associations: buildAssociations({
      deviceMap,
      devices,
      scenes,
      configured
    })
  };
}

function associateDeviceName(device, { name, sku } = {}, {
  ignoreDevices = [],
  includedDefault
} = {}) {
  const ignore = new Set(ignoreDevices || []);
  const next = { ...device };

  if (sku && !next.sku)
    next.sku = sku;

  if (!name)
    return { device: next, changed: JSON.stringify(next) !== JSON.stringify(device) };

  if (next.name && next.name !== name)
    return { device, changed: false };

  const wasUnnamed = !next.name;
  next.name = name;

  if (next.included === undefined) {
    next.included = includedDefault !== undefined
      ? includedDefault
      : !ignore.has(name);
  } else if (
    wasUnnamed &&
    next.included === false &&
    includedDefault !== false &&
    !ignore.has(name)
  ) {
    next.included = true;
  }

  return {
    device: next,
    changed: JSON.stringify(next) !== JSON.stringify(device)
  };
}

function applyLanDevice(old = {}, { id, ip, sku, name } = {}, { ignoreDevices = [] } = {}) {
  const ignore = new Set(ignoreDevices || []);
  const next = {
    ...old,
    id,
    ip,
    sku: sku || old.sku
  };

  const resolvedName = name || old.name || '';
  if (resolvedName)
    next.name = resolvedName;

  if (next.included === undefined)
    next.included = resolvedName ? !ignore.has(resolvedName) : true;

  const changed =
    old.id !== next.id ||
    old.ip !== next.ip ||
    old.sku !== next.sku ||
    old.name !== next.name ||
    old.included !== next.included;

  return { device: next, changed };
}

function normalizeBrightness(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100)
    return undefined;
  return n;
}

function isOlderSeen(incomingSeen, previousSeen) {
  if (!incomingSeen || !previousSeen)
    return false;

  const incomingMs = Date.parse(incomingSeen);
  const previousMs = Date.parse(previousSeen);

  return !Number.isNaN(incomingMs) &&
    !Number.isNaN(previousMs) &&
    incomingMs < previousMs;
}

function applyLearnedScene(previous, incoming) {
  if (isOlderSeen(incoming.lastSeen, previous?.lastSeen))
    return { scene: previous, changed: false };

  const deviceId = hasDeviceId(incoming.deviceId)
    ? incoming.deviceId
    : (previous?.deviceId || '');
  const lastSeen = newerIso(previous?.lastSeen, incoming.lastSeen);
  const code = incoming.code !== undefined
    ? incoming.code
    : (previous?.code || []);
  const brightness = incoming.brightness !== undefined
    ? incoming.brightness
    : previous?.brightness;

  if (
    previous &&
    previous.deviceId === deviceId &&
    previous.deviceName === incoming.deviceName &&
    previous.sceneName === incoming.sceneName &&
    sameCode(previous.code, code) &&
    previous.brightness === brightness
  ) {
    if (lastSeen && lastSeen !== previous.lastSeen) {
      return {
        scene: { ...previous, lastSeen },
        changed: true,
        touch: true
      };
    }

    return { scene: previous, changed: false };
  }

  const scene = {
    deviceId,
    deviceName: incoming.deviceName,
    sceneName: incoming.sceneName,
    code,
    included: previous?.included === undefined ? true : previous.included,
    lastSeen: lastSeen || ''
  };

  if (brightness !== undefined)
    scene.brightness = brightness;

  return {
    scene,
    changed: true
  };
}

function backfillSceneDeviceIds(scenes, name, id) {
  if (!name || !hasDeviceId(id))
    return { scenes, changed: false };

  let changed = false;
  const next = scenes.map(scene => {
    if (scene.deviceName === name && !hasDeviceId(scene.deviceId)) {
      changed = true;
      return { ...scene, deviceId: id };
    }

    return scene;
  });

  return { scenes: next, changed };
}

function groupScenesByName(scenes = []) {
  const groups = new Map();

  for (const scene of scenes) {
    const name = scene?.sceneName;
    if (!name)
      continue;

    if (!groups.has(name))
      groups.set(name, []);

    groups.get(name).push(scene);
  }

  return groups;
}

function ttrSendTargets(members = [], devices = {}) {
  return members.filter(scene => {
    if (!scene || scene.included === false || !hasDeviceId(scene.deviceId))
      return false;

    if (!Array.isArray(scene.code) || !scene.code.length)
      return false;

    const device = devices[scene.deviceId];
    return !!(device && device.ip);
  });
}

function ttrUuidFor(scene) {
  return accessoryUUIDSource(scene.deviceId, scene.sceneName);
}

function ttrOwners(scenes = [], devices = {}, cachedUUIDs = []) {
  const owners = new Map();

  for (const [name, members] of groupScenesByName(scenes)) {
    const picked = pickTtrAccessory(members, {
      devices,
      cachedUUIDs,
      uuidFor: ttrUuidFor
    });

    if (picked)
      owners.set(name, picked.scene);
  }

  return owners;
}

function sameSceneRow(a, b) {
  return !!(a && b &&
    a.deviceName === b.deviceName &&
    a.sceneName === b.sceneName);
}

// One HomeKit switch per TTR name. Extra device recipes fan out on send;
// they never get their own accessory, even if those devices are included.
function pickTtrAccessory(members = [], {
  devices = {},
  cachedUUIDs = [],
  uuidFor
} = {}) {
  const publishable = members.filter(scene =>
    shouldPublish(scene, { devices })
  );

  if (!publishable.length)
    return null;

  const cached = new Set(cachedUUIDs);
  const cachedMember = publishable.find(scene => cached.has(uuidFor(scene)));
  const scene = cachedMember || publishable.slice().sort((a, b) =>
    String(a.deviceId).localeCompare(String(b.deviceId))
  )[0];

  return { scene, uuid: uuidFor(scene) };
}

function shouldPublish(scene, { devices = {}, ignoreDevices = [] } = {}) {
  if (!scene || !hasDeviceId(scene.deviceId))
    return false;

  if (!Array.isArray(scene.code) || !scene.code.length)
    return false;

  if (scene.included === false)
    return false;

  const device = devices[scene.deviceId];
  if (!device || device.included === false)
    return false;

  return true;
}

function inclusionSnapshot(state = {}) {
  const devices = (state.devices || [])
    .map(device => `${device.id}\0${device.included !== false}`)
    .sort();
  const scenes = (state.scenes || [])
    .map(scene => `${scene.deviceName}\0${scene.sceneName}\0${scene.included !== false}`)
    .sort();

  return JSON.stringify({ devices, scenes });
}

function mergeInclusion(current = {}, disk = {}) {
  const diskDevices = new Map(
    (disk.devices || []).filter(d => d.id).map(d => [d.id, d])
  );
  const diskScenes = new Map(
    (disk.scenes || []).map(s => [sceneKey(s.deviceName, s.sceneName), s])
  );

  const devices = (current.devices || []).map(device => {
    const other = diskDevices.get(device.id);
    if (!other || other.included === undefined || other.included === device.included)
      return device;

    return { ...device, included: other.included };
  });

  const scenes = (current.scenes || []).map(scene => {
    const other = diskScenes.get(sceneKey(scene.deviceName, scene.sceneName));
    if (!other || other.included === undefined || other.included === scene.included)
      return scene;

    return { ...scene, included: other.included };
  });

  return {
    devices,
    scenes,
    deletedScenes: disk.deletedScenes || current.deletedScenes || [],
    changed: inclusionSnapshot({ devices, scenes }) !==
      inclusionSnapshot(current)
  };
}

function editSnapshot(state = {}) {
  return JSON.stringify({
    inclusion: inclusionSnapshot(state),
    scenes: (state.scenes || [])
      .map(scene => sceneKey(scene.deviceName, scene.sceneName))
      .sort(),
    deleted: (state.deletedScenes || [])
      .map(item => deletedKey(item))
      .sort()
  });
}

function applyDiskEdits(memory = {}, disk = {}) {
  const merged = mergeInclusion({
    devices: memory.devices || [],
    scenes: memory.scenes || []
  }, disk);
  const tombs = new Map(
    (memory.deletedScenes || []).map(item => [deletedKey(item), item])
  );

  for (const tomb of disk.deletedScenes || []) {
    const key = deletedKey(tomb);
    const scene = merged.scenes.find(item =>
      sceneKey(item.deviceName, item.sceneName) === key
    );

    if (
      scene &&
      scene.lastSeen &&
      Date.parse(scene.lastSeen) > Date.parse(tomb.deletedAt)
    ) {
      continue;
    }

    tombs.set(key, tomb);
  }

  const deletedScenes = [...tombs.values()];
  const scenes = merged.scenes.filter(scene =>
    !shouldSkipDeleted(
      deletedScenes,
      scene.deviceName,
      scene.sceneName,
      scene.lastSeen
    )
  );
  const next = {
    devices: merged.devices,
    scenes,
    deletedScenes
  };

  return {
    ...next,
    changed: editSnapshot(next) !== editSnapshot({
      devices: memory.devices,
      scenes: memory.scenes,
      deletedScenes: memory.deletedScenes
    })
  };
}

function applyDeletedScene(state = {}, { deviceName, sceneName }, deletedAt) {
  const at = deletedAt || new Date().toISOString();
  const scenes = (state.scenes || []).filter(scene =>
    scene.deviceName !== deviceName || scene.sceneName !== sceneName
  );
  const deletedScenes = [
    ...clearTombstone(state.deletedScenes, deviceName, sceneName),
    { deviceName, sceneName, deletedAt: at }
  ];

  return {
    devices: (state.devices || []).map(device => ({ ...device })),
    scenes,
    deletedScenes,
    changed:
      scenes.length !== (state.scenes || []).length ||
      !findTombstone(state.deletedScenes, deviceName, sceneName)
  };
}

function applyInclusionChange(state = {}, change = {}) {
  const devices = (state.devices || []).map(device => ({ ...device }));
  const scenes = (state.scenes || []).map(scene => ({ ...scene }));
  const included = !!change.included;
  let changed = false;

  if (change.kind === 'device') {
    for (const device of devices) {
      if (device.name === change.name && device.included !== included) {
        device.included = included;
        changed = true;
      }
    }
  } else if (change.kind === 'scene') {
    for (const scene of scenes) {
      if (
        scene.deviceName === change.deviceName &&
        scene.sceneName === change.sceneName &&
        scene.included !== included
      ) {
        scene.included = included;
        changed = true;
      }
    }
  }

  return {
    devices,
    scenes,
    deletedScenes: state.deletedScenes || [],
    changed
  };
}

function buildUiState(state = {}) {
  const devices = state.devices || [];
  const scenes = state.scenes || [];
  const deviceById = Object.fromEntries(
    devices.filter(device => device.id).map(device => [device.id, device])
  );
  const groups = new Map();

  function groupFor(name, device) {
    const key = device?.id || name || 'unknown';

    if (!groups.has(key)) {
      groups.set(key, {
        name: device?.name || name || 'Unknown device',
        sku: device?.sku || '',
        associated: !!(device && hasDeviceId(device.id)),
        included: device ? device.included !== false : true,
        scenes: []
      });
    }

    return groups.get(key);
  }

  for (const device of devices)
    groupFor(device.name || device.id, device);

  const latest = latestDiscoveryAt(scenes);
  const byName = groupScenesByName(scenes);
  const owners = ttrOwners(scenes, deviceById);

  for (const scene of scenes) {
    const device = deviceById[scene.deviceId] ||
      devices.find(item => item.name === scene.deviceName);
    const group = groupFor(scene.deviceName, device);
    const inLatest = isInLatestDiscovery(scene.lastSeen, latest);

    const peers = (byName.get(scene.sceneName) || [])
      .filter(item => item !== scene)
      .map(item => item.deviceName)
      .filter(Boolean);
    const owner = owners.get(scene.sceneName);
    const ttrPublished = !!owner;
    const published = sameSceneRow(owner, scene);

    group.scenes.push({
      deviceName: scene.deviceName,
      sceneName: scene.sceneName,
      included: scene.included !== false,
      associated: hasDeviceId(scene.deviceId),
      published,
      ttrPublished,
      switchOwner: owner?.deviceName || '',
      linkedDevices: peers,
      brightness: Number.isInteger(scene.brightness) ? scene.brightness : null,
      lastSeen: scene.lastSeen || '',
      lastSeenLabel: formatLastSeen(scene.lastSeen),
      inLatestDiscovery: inLatest,
      discoveryStatus: inLatest
        ? 'Seen in latest discovery'
        : 'Not seen in latest discovery'
    });
  }

  return {
    devices: [...groups.values()]
      .map(group => ({
        ...group,
        scenes: group.scenes.sort((a, b) =>
          a.sceneName.localeCompare(b.sceneName)
        )
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

function planAccessoryReconciliation({
  scenes = [],
  devices = {},
  ignoreDevices = [],
  cachedUUIDs = [],
  uuidFor
} = {}) {
  const cached = new Set(cachedUUIDs);
  const desired = [];
  const desiredUUIDs = new Set();

  for (const members of groupScenesByName(scenes).values()) {
    const picked = pickTtrAccessory(members, {
      devices,
      cachedUUIDs,
      uuidFor
    });

    if (!picked)
      continue;

    desired.push(picked);
    desiredUUIDs.add(picked.uuid);
  }

  return {
    desired,
    keep: desired.filter(item => cached.has(item.uuid)),
    missing: desired.filter(item => !cached.has(item.uuid)),
    staleUUIDs: [...cached].filter(uuid => !desiredUUIDs.has(uuid))
  };
}

function parseTtrRuleDebug(line) {
  const marker = ' ttr rule debug: ';
  const at = line.indexOf(marker);

  if (at === -1)
    return null;

  const names = line.slice(0, at).match(/\[Govee\] \[([^\]]+)\] \[([^\]]+)\]$/);

  if (!names)
    return null;

  let raw = line.slice(at + marker.length).trim();
  if (raw.endsWith('.'))
    raw = raw.slice(0, -1);

  let rule;
  try {
    rule = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  let brightness;

  if (rule.cmdVal) {
    try {
      const cmdVal = typeof rule.cmdVal === 'string'
        ? JSON.parse(rule.cmdVal)
        : rule.cmdVal;
      brightness = normalizeBrightness(cmdVal?.brightness);
    } catch (_) {}
  }

  if (brightness === undefined && rule.iotMsg) {
    try {
      const iot = JSON.parse(rule.iotMsg);
      if (iot.msg?.cmd === 'brightness')
        brightness = normalizeBrightness(
          iot.msg.data?.val ?? iot.msg.data?.value
        );
    } catch (_) {}
  }

  if (brightness === undefined)
    return null;

  return {
    type: 'brightness',
    deviceName: names[1],
    sceneName: names[2],
    brightness
  };
}

function parseGoveeLine(line) {
  line = stripAnsi(line);

  const init = line.match(
    /\[Govee\] \[([^\]]+)\] initialised with id \[([^\]]+)\] \[([^\]]+)\]/
  );

  if (init) {
    return {
      type: 'init',
      name: init[1],
      id: init[2],
      sku: init[3]
    };
  }

  const debug = parseTtrRuleDebug(line);
  if (debug)
    return debug;

  const marker = '] [Govee] [';
  const start = line.indexOf(marker);

  if (start === -1 || !line.includes('] [AWS] '))
    return null;

  const payload = line.slice(start + marker.length);
  const match = payload.match(
    /^([^\]]+)\] \[([^\]]+)\] \[AWS\] (.+)$/
  );

  if (!match)
    return null;

  return {
    type: 'scene',
    deviceName: match[1],
    sceneName: match[2],
    code: match[3].split(',').filter(Boolean)
  };
}

module.exports = {
  accessoryUUIDSource,
  applyDeletedScene,
  applyDiskEdits,
  applyInclusionChange,
  applyLanDevice,
  applyLearnedScene,
  associateDeviceName,
  backfillSceneDeviceIds,
  buildAssociations,
  buildUiState,
  clearTombstone,
  editSnapshot,
  findTombstone,
  formatLastSeen,
  hasDeviceId,
  inclusionSnapshot,
  isInLatestDiscovery,
  latestDiscoveryAt,
  mergeInclusion,
  migrateState,
  parseGoveeConfiguredDevices,
  parseGoveeLine,
  parseHomebridgeTime,
  normalizeBrightness,
  pickTtrAccessory,
  planAccessoryReconciliation,
  groupScenesByName,
  sameSceneRow,
  ttrOwners,
  ttrSendTargets,
  pluginStateDir,
  resolveDeviceId,
  resolvePluginStateDir,
  sceneKey,
  shouldPublish,
  shouldSkipDeleted,
  stripAnsi
};
