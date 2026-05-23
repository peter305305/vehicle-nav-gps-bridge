import maplibregl, { LngLatLike, Map as MlMap, Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Destination } from './types';
import { vehicleMarkerSvg } from './vehicle-marker.svg';

interface VehiclePos {
  lat: number;
  lon: number;
  heading: number;
}

const CONNECTOR_SOURCE = 'vehicle-connector';
const CONNECTOR_LAYER_GLOW = 'vehicle-connector-glow';
const CONNECTOR_LAYER = 'vehicle-connector-line';

// We only recenter when the marker drifts outside this central box (expressed as a
// fraction of the viewport). At city speeds the GPS jitter would otherwise cause the
// map to pan constantly, which feels nauseating; clamping recentre to this dead zone
// keeps the experience calm without ever letting the vehicle disappear off-screen.
const RECENTRE_DEAD_ZONE = 0.3;

// Names of every MapLibre gesture handler we toggle together. dragRotate and
// touchPitch are intentionally omitted — rotation/tilt stay disabled forever so
// the map can never end up off-axis, regardless of interactive mode.
const TOGGLE_HANDLERS = ['dragPan', 'scrollZoom', 'touchZoomRotate', 'doubleClickZoom', 'keyboard', 'boxZoom'] as const;

export class VehicleMap {
  private map: MlMap;
  private vehicleMarker: Marker | null = null;
  private destinationMarker: Marker | null = null;
  private destination: Destination | null = null;
  private currentVehicle: VehiclePos | null = null;
  private styleLoaded = false;
  private connectorPending = false;
  private interactive: boolean;
  private userInteracting = false;
  private userInteractionTimer: number | null = null;

  constructor(containerId: string, styleUrl: string, opts: { interactive?: boolean } = {}) {
    this.interactive = !!opts.interactive;
    // We always construct the map with `interactive: true` so MapLibre attaches
    // every gesture handler up-front; then we individually disable each handler
    // for kiosk mode. This lets setInteractive() flip the state at runtime
    // without reconstructing the map (which would lose camera state).
    this.map = new maplibregl.Map({
      container: containerId,
      style: styleUrl,
      // Default center is Midtown Manhattan (Times Square-ish) — the map only
      // sits here for the few seconds between page load and first GPS fix, so
      // it should be somewhere visually recognizable on a dark style. Once a
      // fix arrives, setVehicle() jumps to the real position.
      center: [-73.9857, 40.7549],
      zoom: 13,
      pitchWithRotate: false,
      dragRotate: false,
      attributionControl: { compact: true },
    });

    // Rotation is permanently disabled — touchZoomRotate stays usable for
    // pinch-zoom but its rotation half is stripped off.
    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.applyInteractive();

    // User-initiated camera events carry an `originalEvent`; programmatic
    // easeTo/jumpTo doesn't. Filter on that so our own centerOnVehicle calls
    // don't trip the "user is exploring" flag.
    const onUserCamera = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) this.markUserInteraction();
    };
    this.map.on('dragstart', onUserCamera);
    this.map.on('zoomstart', onUserCamera);
    this.map.on('wheel', () => this.markUserInteraction());

    this.map.on('load', () => {
      this.styleLoaded = true;
      if (this.connectorPending) this.refreshConnector();
    });
  }

  private applyInteractive(): void {
    for (const name of TOGGLE_HANDLERS) {
      const handler = (this.map as unknown as Record<string, { enable: () => void; disable: () => void }>)[name];
      if (!handler) continue;
      if (this.interactive) handler.enable();
      else handler.disable();
    }
    // Rotation must stay off even after touchZoomRotate.enable() puts it back.
    this.map.touchZoomRotate.disableRotation();
  }

  private markUserInteraction(): void {
    if (!this.interactive) return;
    this.userInteracting = true;
    if (this.userInteractionTimer !== null) clearTimeout(this.userInteractionTimer);
    // After 30s of no panning/zooming, resume auto-recentering on the vehicle. Long
    // enough that an exploratory look-around isn't interrupted, short enough that
    // forgetting about the page doesn't leave the vehicle off-screen forever.
    this.userInteractionTimer = window.setTimeout(() => {
      this.userInteracting = false;
      this.userInteractionTimer = null;
    }, 30000);
  }

  setInteractive(interactive: boolean): void {
    if (this.interactive === interactive) return;
    this.interactive = interactive;
    this.applyInteractive();
    if (!interactive) {
      // Leaving interactive mode — clear the "exploring" timer so auto-recenter
      // resumes immediately rather than waiting out the 30s grace period.
      if (this.userInteractionTimer !== null) {
        clearTimeout(this.userInteractionTimer);
        this.userInteractionTimer = null;
      }
      this.userInteracting = false;
      if (this.currentVehicle) this.forceRecenter();
    }
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  setZoom(zoom: number, opts?: { duration?: number }): void {
    if (!Number.isFinite(zoom)) return;
    this.map.easeTo({ zoom, duration: opts?.duration ?? 400 });
  }

  forceRecenter(opts?: { duration?: number }): void {
    if (!this.currentVehicle) return;
    // Skip the userInteracting check — this is an explicit user-requested
    // recenter from the phone, which should win over any pan they did locally.
    if (this.userInteractionTimer !== null) {
      clearTimeout(this.userInteractionTimer);
      this.userInteractionTimer = null;
    }
    this.userInteracting = false;
    this.map.easeTo({
      center: [this.currentVehicle.lon, this.currentVehicle.lat],
      duration: opts?.duration ?? 500,
    });
  }

  setVehicle(pos: VehiclePos): void {
    this.currentVehicle = pos;
    const lngLat: LngLatLike = [pos.lon, pos.lat];

    if (!this.vehicleMarker) {
      const el = document.createElement('div');
      el.innerHTML = vehicleMarkerSvg;
      el.style.width = '32px';
      el.style.height = '32px';
      el.style.pointerEvents = 'none';
      // rotationAlignment: 'map' keeps the marker's rotation tied to map space rather
      // than viewport space, which matters if the map ever ends up rotated (it won't
      // here, but the setting is correct for a heading-driven arrow).
      this.vehicleMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
        .setLngLat(lngLat)
        .addTo(this.map);
      // First fix: center immediately so the user sees their position without delay.
      this.map.jumpTo({ center: lngLat });
    } else {
      this.vehicleMarker.setLngLat(lngLat);
    }
    this.vehicleMarker.setRotation(pos.heading);
    this.refreshConnector();
  }

  setDestination(dest: Destination | null): void {
    this.destination = dest;
    if (!dest) {
      if (this.destinationMarker) {
        this.destinationMarker.remove();
        this.destinationMarker = null;
      }
      this.refreshConnector();
      return;
    }

    const lngLat: LngLatLike = [dest.lon, dest.lat];
    if (!this.destinationMarker) {
      // Two stacked elements inside one marker: an outer pulsing halo + a
      // crisp inner dot. The halo is keyframe-animated in style.css; we just
      // hand MapLibre the markup and let CSS do the rest.
      const el = document.createElement('div');
      el.className = 'dest-marker';
      el.innerHTML = '<div class="dest-pulse"></div><div class="dest-dot"></div>';
      el.style.pointerEvents = 'none';
      this.destinationMarker = new maplibregl.Marker({ element: el })
        .setLngLat(lngLat)
        .addTo(this.map);
    } else {
      this.destinationMarker.setLngLat(lngLat);
    }
    // If we don't yet have a vehicle fix, center on the destination so the user sees
    // something useful while we wait for GPS.
    if (!this.currentVehicle) this.map.jumpTo({ center: lngLat });
    this.refreshConnector();
  }

  centerOnVehicle(pos: VehiclePos, opts?: { duration?: number }): void {
    if (this.userInteracting) return;
    const point = this.map.project([pos.lon, pos.lat]);
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const minX = w * (0.5 - RECENTRE_DEAD_ZONE / 2);
    const maxX = w * (0.5 + RECENTRE_DEAD_ZONE / 2);
    const minY = h * (0.5 - RECENTRE_DEAD_ZONE / 2);
    const maxY = h * (0.5 + RECENTRE_DEAD_ZONE / 2);
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) return;
    this.map.easeTo({ center: [pos.lon, pos.lat], duration: opts?.duration ?? 300 });
  }

  private refreshConnector(): void {
    if (!this.styleLoaded) {
      this.connectorPending = true;
      return;
    }
    this.connectorPending = false;

    const haveLine = this.currentVehicle && this.destination;
    const existingSource = this.map.getSource(CONNECTOR_SOURCE) as maplibregl.GeoJSONSource | undefined;

    if (!haveLine) {
      if (this.map.getLayer(CONNECTOR_LAYER)) this.map.removeLayer(CONNECTOR_LAYER);
      if (this.map.getLayer(CONNECTOR_LAYER_GLOW)) this.map.removeLayer(CONNECTOR_LAYER_GLOW);
      if (existingSource) this.map.removeSource(CONNECTOR_SOURCE);
      return;
    }

    const v = this.currentVehicle!;
    const d = this.destination!;
    const data: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [v.lon, v.lat],
          [d.lon, d.lat],
        ],
      },
    };

    if (existingSource) {
      existingSource.setData(data);
      return;
    }

    this.map.addSource(CONNECTOR_SOURCE, { type: 'geojson', data });
    // Two layers stacked: a wide, blurred-feel glow underneath (line-blur +
    // higher width) and a crisp dashed line on top. The combination reads as
    // "this line glows" without needing a real bloom filter, which MapLibre
    // can't do on lines directly.
    this.map.addLayer({
      id: CONNECTOR_LAYER_GLOW,
      type: 'line',
      source: CONNECTOR_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#22D3EE',
        'line-width': 10,
        'line-opacity': 0.22,
        'line-blur': 6,
      },
    });
    this.map.addLayer({
      id: CONNECTOR_LAYER,
      type: 'line',
      source: CONNECTOR_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#67E8F9',
        'line-width': 2.5,
        'line-opacity': 0.9,
        'line-dasharray': [2, 2.5],
      },
    });
  }
}
