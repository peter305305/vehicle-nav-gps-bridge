import { config, getDestinationFromEnv } from './config';
import { GpsClient } from './gps';
import { PositionAnimator } from './interpolation';
import { VehicleMap } from './map';
import { MutableDestinationProvider } from './destination';
import { DirectionsService } from './directions';
import { Overlay } from './overlay';
import { ControlClient } from './control';
import './style.css';

const map = new VehicleMap('map', config.mapStyleUrl, { interactive: config.mapInteractive });
const overlay = new Overlay('overlay');
const animator = new PositionAnimator();
const directions = new DirectionsService(config.mapboxToken, config.directionsRefreshMs);

const destProvider = new MutableDestinationProvider(getDestinationFromEnv());
destProvider.onChange((d) => {
  map.setDestination(d);
  directions.setDestination(d);
});

const initialDest = destProvider.getCurrent();
map.setDestination(initialDest);
directions.setDestination(initialDest);

const gps = new GpsClient(config.gpsWsUrl);

gps.onReading((r) => {
  if (r.hasFix && r.lat !== null && r.lon !== null) {
    overlay.setStale(false);
    animator.update(r);
    directions.setVehicle({ lat: r.lat, lon: r.lon });
  } else {
    overlay.setStale(true);
  }
  // Speed/heading update at GPS rate (10Hz) — the live numbers should never lag behind
  // the marker. Directions ETA/distance update on a separate slower cadence.
  overlay.updateLive({ speedMph: r.speedMph, heading: r.heading });
});

gps.onConnectionState((s) => {
  if (s !== 'open') overlay.setStale(true);
});

gps.start();

animator.onFrame((pos) => {
  map.setVehicle(pos);
  map.centerOnVehicle(pos);
});
animator.start();

directions.onResult((res) => {
  overlay.updateDirections(res);
});

// Control channel — phone control page drives the map at runtime via the
// bridge's /control WS. We seed the bridge with our env-derived state so a
// fresh boot reflects the display's defaults; once the phone touches something
// the bridge's value wins from then on.
const control = new ControlClient(config.controlWsUrl);
control.setInitPayload({
  interactive: config.mapInteractive,
  // We don't track zoom locally beyond the map default (13), so seed with that
  // so the phone UI shows the right preset highlighted on first connect.
  zoom: 13,
  destination: initialDest,
});
control.onState((s) => {
  if (s.interactive !== undefined) map.setInteractive(s.interactive);
  if (s.zoom !== undefined) map.setZoom(s.zoom);
  // destination present in payload means the bridge has an opinion — either a
  // real Destination (set) or null (explicitly cleared). Absent → ignore.
  if ('destination' in s) destProvider.setDestination(s.destination ?? null);
});
control.onRecenter(() => map.forceRecenter());
control.start();
