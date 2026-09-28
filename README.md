# Homebridge Govee Scene Extractor

<p align="center">
  <img src="branding/icon.png" width="128" alt="Homebridge Govee Scene Extractor">
</p>

Companion Homebridge plugin. It learns Govee Tap-to-Runs from the stock Govee plugin, exposes one momentary HomeKit switch per scene name, and plays those scenes on the LAN (UDP 4003). It does not talk to Govee AWS to fire a scene.

The npm package is `homebridge-govee-scene-extractor`.

## Install

From the Homebridge UI: **Plugins** → search `homebridge-govee-scene-extractor`.

Or:

```sh
npm install -g homebridge-govee-scene-extractor
```

This plugin requires the stock [homebridge-govee](https://github.com/homebridge-plugins/homebridge-govee) plugin running as well.

## What to know

- Check a device or scene in the plugin UI to put it in HomeKit. Changes apply in about a second.
- Tap-to-Run/Scenes across multiple devices will only be one Switch in HomeKit. Flipping that switch sends every linked recipe that is checked and has a LAN IP, even if that device is unchecked.
- Brightness is a separate Govee command. We send it over LAN when a dump includes it. The UI shows `Brightness: N%` on those rows.
- Remove drops a scene from this plugin. If Govee still has that Tap-to-Run, the next discovery brings it back.
- New or edited Tap-to-Runs appear only when stock Govee refetches them (child-bridge start). Restart Govee after you add a TTR. Brightness is read from that same TTR list.

## How it works

1. Stock Govee dumps Tap-to-Run rules at startup (`[AWS]` scene codes, and `ttr rule debug` when debug is on).
2. This plugin harvests those lines, associates device names to ids (stock Govee `lightDevices`, then optional `deviceMap`), and matches LAN IPs from a short UDP scan.
3. HomeKit gets one switch per scene name. The switch UUID is `govee-scene-extractor:<deviceId>:<sceneName>` for the chosen owner device.
4. On press: LAN turn on, then brightness if known, then the captured `ptReal` animation, per linked device.

Plugin state lives in `~/.homebridge/govee-scene-extractor/state.json`. That is a sibling of stock Govee's `bwp91_cache` folder, not inside HAP `persist/`.

## Config

```json
{
  "platform": "GoveeSceneExtractor",
  "name": "Govee Scene Extractor"
}
```

Optional:

- `logPath` — leave unset to use `homebridge.log` in the Homebridge storage folder
- `deviceMap` — fallback name-to-id map if stock Govee config still has no id for a light
- `resetAfterMs` — how long the HomeKit switch stays on before flipping back (default `1000`)

Inclusion is controlled in the plugin UI, not `ignoreDevices`.
