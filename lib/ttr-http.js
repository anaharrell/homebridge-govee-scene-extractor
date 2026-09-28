'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { normalizeBrightness } = require('./state');

const TTR_URL = 'https://app2.govee.com/bff-app/v1/exec-plat/home';
const APP_VERSION = '7.4.10';

function brightnessFromRule(rule = {}) {
  if (rule.cmdVal) {
    try {
      const cmdVal = typeof rule.cmdVal === 'string'
        ? JSON.parse(rule.cmdVal)
        : rule.cmdVal;
      const n = normalizeBrightness(cmdVal?.brightness);
      if (n !== undefined)
        return n;
    } catch (_) {}
  }

  if (rule.iotMsg) {
    try {
      const iot = typeof rule.iotMsg === 'string'
        ? JSON.parse(rule.iotMsg)
        : rule.iotMsg;
      if (iot?.msg?.cmd === 'brightness')
        return normalizeBrightness(
          iot.msg.data?.val ?? iot.msg.data?.value
        );
    } catch (_) {}
  }

  return undefined;
}

function extractTtrBrightness(components = []) {
  const rows = [];

  for (const component of components) {
    for (const oneClick of component.oneClicks || []) {
      const sceneName = oneClick.name;
      if (!sceneName)
        continue;

      for (const iotRule of oneClick.iotRules || []) {
        const deviceName = iotRule.deviceObj?.name;
        if (!deviceName)
          continue;

        for (const rule of iotRule.rule || []) {
          const brightness = brightnessFromRule(rule);
          if (brightness === undefined)
            continue;

          rows.push({ deviceName, sceneName, brightness });
        }
      }
    }
  }

  return rows;
}

function readCachedTtrToken(storagePath) {
  const dir = path.join(storagePath, 'bwp91_cache');

  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.'))
        continue;

      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(dir, name), 'utf8')
        );

        if (raw.key !== 'Govee_All_Devices_temp')
          continue;

        const token = String(raw.value || '').split(':::')[6] || '';
        if (token && token !== 'undefined')
          return token;
      } catch (_) {}
    }
  } catch (_) {}

  return '';
}

function goveeClientId(username, uuidGenerate) {
  if (!username || typeof uuidGenerate !== 'function')
    return 'hb';

  let suffix = String(uuidGenerate(username)).replace(/-/g, '');
  suffix = suffix.substring(0, Math.max(0, suffix.length - 2));
  return `hb${suffix}`;
}

function goveeUsernameFromConfig(config = {}) {
  for (const platform of config.platforms || []) {
    if (platform?.platform === 'Govee' && platform.username)
      return String(platform.username);
  }

  return '';
}

function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

async function fetchTtrComponents({ token, clientId }) {
  if (!token)
    throw new Error('No TTR token');

  const json = await httpsGetJson(TTR_URL, {
    Authorization: `Bearer ${token}`,
    appVersion: APP_VERSION,
    clientId: clientId || 'hb',
    clientType: 1,
    iotVersion: 0,
    timestamp: String(Date.now()),
    'User-Agent': `GoveeHome/${APP_VERSION} (com.ihoment.GoVeeSensor; build:8; iOS 26.5.0) Alamofire/5.11.0`
  });

  const components = json?.data?.data?.components || json?.data?.components;
  if (!Array.isArray(components))
    throw new Error('not a valid TTR response');

  return components;
}

module.exports = {
  brightnessFromRule,
  extractTtrBrightness,
  fetchTtrComponents,
  goveeClientId,
  goveeUsernameFromConfig,
  readCachedTtrToken
};
