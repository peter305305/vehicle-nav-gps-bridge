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
const CONNECTOR_LAYER = 'vehicle-connector-line';

// We only recenter when the marker drifts outside this central box (expressed as a
// fraction of the viewport). At city speeds the GPS jitter would otherwise cause the
// map to pan constantly, which feels nauseating; clamping recentre to this dead zone
// keeps the experience calm without ever letting the vehicle disappear off-screen.
const RECENTRE_DEAD_ZONE = 0.3;

export class VehicleMap {
  private map: MlMap;
  private vehicleMarker: Marker | null = null;
  private destinationMarker: Marker | null = null;
  private destination: Destination | null = null;
  private currentVehicle: VehiclePos | null = null;
  private styleLoaded = false;
  private connectorPending = false;

  constructor(containerId: string, styleUrl: string) {
    // The display is passive — pitchWithRotate/dragRotate/touchZoomRotate are off so
    // the map can never end up rotated or tilted. `interactive: false` disables every
    // gesture handler in one go (no scroll-zoom, no drag-pan).
    this.map = new maplibregl.Map({
      container: containerId,
      style: styleUrl,
      center: [-80.13, 25.7907],
      zoom: 13,
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: false,
      interactive: false,
      attributionControl: { compact: true },
    });

    this.map.on('load', () => {
      this.styleLoaded = true;
      if (this.connectorPending) this.refreshConnector();
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
      const el = document.createElement('div');
      el.style.width = '18px';
      el.style.height = '18px';
      el.style.borderRadius = '50%';
      el.style.background = '#22D3EE';
      el.style.boxShadow = '0 0 0 4px rgba(34, 211, 238, 0.25), 0 2px 8px rgba(0,0,0,0.5)';
      el.style.border = '2px solid #0B1620';
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
    this.map.addLayer({
      id: CONNECTOR_LAYER,
      type: 'line',
      source: CONNECTOR_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#67E8F9',
        'line-width': 2,
        'line-opacity': 0.6,
        'line-dasharray': [2, 2],
      },
    });
  }
}
