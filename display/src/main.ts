import { config, getDestinationFromEnv } from './config';
import { GpsClient } from './gps';
import { PositionAnimator } from './interpolation';
import { VehicleMap } from './map';
import { StaticDestinationProvider } from './destination';
import { DirectionsService } from './directions';
import { Overlay } from './overlay';
import './style.css';

const map = new VehicleMap('map', config.mapStyleUrl);
const overlay = new Overlay('overlay');
const animator = new PositionAnimator();
const directions = new DirectionsService(config.mapboxToken, config.directionsRefreshMs);

const destProvider = new StaticDestinationProvider(getDestinationFromEnv());
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
