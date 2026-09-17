# Vehicle Nav on a Mac Mini — Hands-Free Install Guide

This guide takes a Mac Mini from a fresh macOS install to an unattended in-car navigation display. After setup, the Mini powers on by itself when the car supplies power, logs in with no one touching it, and shows a fullscreen moving map on its HDMI output. A phone on the same Wi-Fi can lock/unlock the map, recenter, change zoom, and set a destination.

Time required: about 30 minutes at the keyboard, plus download time for Homebrew and Chrome.

## What you need

- A Mac Mini (Apple silicon or Intel) running macOS 13 Ventura or newer, with a keyboard, mouse and display connected for the setup.
- An internet connection during setup.
- A USB GPS receiver. Tested targets: u-blox M10 (plug and play) and GlobalSat BU-353N (may need the Prolific driver from the Mac App Store on some macOS versions).
- The Mini needs internet in the car too, for map tiles and (optionally) ETA. A phone hotspot or car Wi-Fi hotspot works. The phone control page also requires the phone and the Mini to be on the same network.

## Part 1 — System Settings (must be done by hand)

Open **System Settings** and work through these. macOS does not allow a script to change them.

| Setting | Where | Value | Why |
|---|---|---|---|
| Kiosk user | Users & Groups | A standard user account. Everything runs as this user. | The map runs inside this user's login session. |
| FileVault | Privacy & Security → FileVault | **Off** | Automatic login is not possible with FileVault on. |
| Automatic login | Users & Groups → Automatic login | The kiosk user | Boots straight into the desktop with no sign-in. |
| Screen saver | Lock Screen → Start Screen Saver when inactive | Never | Nothing must cover the map. |
| Display off | Lock Screen → Turn display off when inactive | Never | Same. |
| Password after screen saver | Lock Screen → Require password after… | Never | Avoids a lock screen if anything ever does blank the display. |
| macOS updates | General → Software Update → Automatic updates | Turn **off** "Install macOS updates" | An automatic update restart would kill the display mid-trip. |
| Notifications | Focus | Create a Do Not Disturb focus scheduled all day | No banners over the map. |
| Local hostname | General → Sharing → Local hostname | Something short, e.g. `carmini` | The phone control page will be `http://carmini.local:8080/`. |
| Remote Login | General → Sharing → Remote Login | On, only if you want to push updates over SSH later | Optional. |
| Firewall | Network → Firewall | Off, **or** click Allow when macOS asks about `node` after the install | Otherwise the phone can't reach the bridge. |

## Part 2 — Install Homebrew

Log in as the kiosk user and open **Terminal** (Applications → Utilities). Paste:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for the user's password, installs Apple's Command Line Tools if needed, and at the end prints two or three lines under **"Next steps"** starting with `echo` and `eval`. Copy and run those too. Then confirm it works:

```bash
brew --version
```

## Part 3 — Clone and run the installer

Plug in the GPS receiver now if you have it (not required; it can be added later).

```bash
git clone https://github.com/beem23/vehicle-nav-gps-bridge.git ~/vehicle-nav-gps-bridge
```

```bash
cd ~/vehicle-nav-gps-bridge && ./scripts/macos/install-mac.sh
```

The installer asks for the password once (for `sudo`, to change power settings). It then:

1. installs Node.js and Google Chrome via Homebrew if they're missing,
2. builds the display app,
3. creates the config file `~/.config/vehicle-nav/bridge.env`,
4. installs and starts two background services (LaunchAgents): the GPS bridge and the Chrome kiosk,
5. disables sleep, display sleep and the screensaver, and turns on "restart after power failure",
6. removes Gatekeeper's "downloaded from the internet" flag from Chrome so the first launch shows no dialog.

**Chrome takes over the screen as soon as the installer finishes.** That's expected. To get the desktop back while you keep working:

```bash
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh stop kiosk
```

Bring it back with `start kiosk`. It also comes back on its own at the next login or reboot.

## Part 4 — Configure (optional)

Skip this if you're using a u-blox receiver and don't need address search.

```bash
nano ~/.config/vehicle-nav/bridge.env
```

| Variable | Set it when |
|---|---|
| `MAPBOX_TOKEN` | You want to type addresses on the phone instead of lat/lon. Needs a free Mapbox public token (`pk.…`). |
| `GPS_BAUD_RATE` | Using a BU-353N: set `115200`. u-blox stays at `9600`. Unsure: run `node ~/vehicle-nav-gps-bridge/gps-bridge/probe.js`. |
| `GPS_SERIAL_PORT` | Only if auto-detect picks the wrong device. Normally leave empty. |

Save (Ctrl+O, Enter, Ctrl+X), then apply:

```bash
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh restart bridge
```

For ETA and distance on the display itself, the same Mapbox token also goes in the display's config, followed by a rebuild:

```bash
cd ~/vehicle-nav-gps-bridge/display && cp .env.example .env && nano .env
```

Set `VITE_MAPBOX_TOKEN=pk.…`, save, then:

```bash
npm run build && ~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh restart kiosk
```

## Part 5 — Verify

```bash
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh status
```

Expected: `bridge: loaded, running (pid …)`, `kiosk: loaded, running (pid …)`, and a `healthz:` line with `"ok":true`.

Check that the bridge found the GPS:

```bash
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh logs bridge
```

You should see a line like `Opening /dev/cu.usbmodem… @ 9600 baud`, and once the receiver has a view of the sky, lines starting with `FIX`. If instead you see `No GPS serial port found` repeating, macOS doesn't see the receiver: try another USB port or cable, and for a BU-353N install the Prolific driver. Press Ctrl+C to stop watching the log.

Now the real test:

```bash
sudo reboot
```

Within about 30 seconds the Mini should be back at the fullscreen map with no login screen. Open `http://carmini.local:8080/` (or whatever hostname you chose) on a phone on the same Wi-Fi to confirm the control page connects.

If the Mini stops at a login screen, automatic login didn't take. Nearly always this means FileVault is still on: turn it off (it may take a while to decrypt), then set automatic login again.

## Day-to-day commands

All from Terminal on the Mini.

```bash
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh status           # is everything running?
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh stop kiosk       # quit Chrome to use the desktop
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh start kiosk      # bring the map back
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh restart bridge   # after editing bridge.env
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh logs bridge      # live GPS log (Ctrl+C to exit)
~/vehicle-nav-gps-bridge/scripts/macos/ctl.sh logs kiosk       # Chrome launcher log
```

Updating to a newer version of the software:

```bash
cd ~/vehicle-nav-gps-bridge && git pull && ./scripts/macos/install-mac.sh
```

The installer is safe to re-run. It never overwrites your `bridge.env`.

## How it stays hands-free

- **Power on:** `pmset autorestart` makes the Mini boot when power returns after a cut, so it comes up with the car.
- **Sign in:** automatic login opens the kiosk user's desktop session with no interaction.
- **Services:** macOS `launchd` starts the bridge and the kiosk from `~/Library/LaunchAgents/` at login. Both are marked KeepAlive, so if Node or Chrome ever exits, launchd restarts it within seconds.
- **Startup order:** the kiosk launcher waits for the bridge's health check before opening Chrome, so it never lands on a "can't connect" page.
- **Never sleeps:** `pmset` disables sleep and display sleep, and Chrome additionally runs under `caffeinate`.
- **GPS hot-plug:** the bridge scans for a receiver every 5 seconds and reconnects if it disappears, so a late plug-in or a USB re-enumeration after a power blip needs no restart.
- **No dialogs:** Chrome runs with its own profile and flags that suppress first-run, update and crash-restore prompts; its Gatekeeper flag is removed at install; Do Not Disturb hides notifications; automatic macOS updates are off.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Login screen after boot | FileVault on, or automatic login not set | Turn FileVault off, set automatic login again |
| Map shows "GPS SIGNAL LOST" forever | Receiver not detected, wrong baud rate, or no sky view | `ctl.sh logs bridge`; check `ls /dev/cu.usb*`; try `probe.js`; move the antenna |
| Phone control page won't load | Different network, firewall blocking node, wrong hostname | Same Wi-Fi as the Mini; allow `node` in Firewall; try the IP the bridge prints in its log |
| Address search greyed out on phone | No `MAPBOX_TOKEN` | Set it in `bridge.env`, restart bridge |
| ETA / distance show "—" | No `VITE_MAPBOX_TOKEN` in `display/.env`, or no internet | Set it and rebuild; check connectivity |
| Chrome windowed instead of fullscreen | Launcher picked an unexpected browser | `ctl.sh logs kiosk` shows which; set `KIOSK_BROWSER` in `bridge.env` |
| Blank/grey map | No internet for map tiles | Give the Mini internet in the car |
| Screen went to sleep | Power settings not applied (installer run with `--no-power`) | Re-run `install-mac.sh` without the flag |

## Where things live

| What | Path |
|---|---|
| Source code | `~/vehicle-nav-gps-bridge/` |
| Bridge config | `~/.config/vehicle-nav/bridge.env` |
| Display config | `~/vehicle-nav-gps-bridge/display/.env` |
| Service definitions | `~/Library/LaunchAgents/com.vehicle-nav.bridge.plist`, `com.vehicle-nav.kiosk.plist` |
| Logs | `~/Library/Logs/vehicle-nav/bridge.log`, `kiosk.log` |
| Kiosk Chrome profile | `~/Library/Application Support/vehicle-nav-kiosk/` |
