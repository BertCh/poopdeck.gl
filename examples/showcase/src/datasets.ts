/**
 * Dataset configurations for the spatiotemporal tiles showcase
 * 
 * Animation speed is now computed automatically based on targetPlaybackSeconds
 * to ensure consistent playback experience across all datasets.
 */

import { Dataset } from './types';

export const datasets: Dataset[] = [
  {
    id: 'earthquake-activity',
    name: 'Earthquake Activity',
    description: 'USGS real-time earthquake feed (M4.5+ from past 30 days)',
    url: '/data/earthquakes.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-01-01T00:28:20.289Z'),
      end: Date.parse('2024-12-30T23:56:29.977Z'),
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 120, // ~5 years plays in 60 seconds
    initialViewState: {
      longitude: -155,
      latitude: 30,
      zoom: 2,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Magnitude",
      items: [
        { color: "#FEE5D9", label: "4.5-5.0" },
        { color: "#FCAE91", label: "5.0-6.0" },
        { color: "#FB6A4A", label: "6.0-7.0" },
        { color: "#DE2D26", label: "7.0-8.0" },
        { color: "#A50F15", label: "8.0+" }
      ]
    },
  },
  {
    id: 'flights',
    name: 'Flight Traffic',
    description: 'Real OpenSky data - 3.96M points, 21K aircraft, 24 hours (Jan 6, 2020)',
    url: '/data/flights.stt',
    type: 'point',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00 UTC
      end: 1578355190000,    // 2020-01-06 23:59 UTC
    },
    timeWindow: 150000, // 15 minute window for 24-hour dataset
    targetPlaybackSeconds: 360, // 24 hours plays in 3 minutes
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 45,
      bearing: 0
    },
    legend: {
      title: "Aircraft",
      items: [
        { color: "#4FC3F7", label: "In Flight" },
      ]
    },
    use3D: true,
    elevationProperty: 'altitude', // Altitude stored in properties (feet)
    elevationScale: 0.3048, // Convert feet to meters
  },
  {
    id: 'flight-paths',
    name: 'Flight Paths',
    description: 'Real OpenSky data - 69K 3D flight trajectories with altitude (Jan 6, 2020)',
    url: '/data/adsb-paths.stt',
    type: 'path',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00:00 UTC
      end: 1578354650000,    // 2020-01-06 23:50:50 UTC
    },
    timeWindow: 600000, // 10 minute window for 24-hour data
    targetPlaybackSeconds: 300, // 24 hours plays in 5 minutes
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 60,
      bearing: 0
    },
    legend: {
      title: "Flight Paths",
      items: [
        { color: "#4FC3F7", label: "Active Flight" },
      ]
    },
    use3D: true,
    elevationScale: 1, // Altitude already in meters (scaled during processing)
  },
  {
    id: 'flight-trips',
    name: 'Flight Trips (3D)',
    description: 'Animated 3D flight trajectories - 21K aircraft moving along routes',
    url: '/data/adsb-paths.stt',
    type: 'trips',
    timeRange: {
      start: 1578268800000,  // 2020-01-06 00:00:00 UTC
      end: 1578354650000,    // 2020-01-06 23:50:50 UTC
    },
    timeWindow: 1800000, // 30 minute window for trips
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 60,
      bearing: 0
    },
    legend: {
      title: "Flight Trips",
      items: [
        { color: "#FD805D", label: "Active Flight" },
      ]
    },
    use3D: true,
    elevationScale: 1, // Altitude already in meters (scaled during processing)
  },
  {
    id: 'hurricanes',
    name: 'Hurricane Tracks',
    description: 'IBTrACS historical hurricane data (Atlantic basin, 2000-2020)',
    url: '/data/hurricanes.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-05-16T18:00:00.000Z'),
      end: Date.parse('2023-11-17T21:00:00.000Z'),
    },
    timeWindow: 86400000 * 14, // 2 week window for multi-year hurricane data
    targetPlaybackSeconds: 120, // ~3.5 years plays in 45 seconds
    initialViewState: {
      longitude: -65,
      latitude: 25,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
  },
  {
    id: 'nyc-rideshare',
    name: 'NYC Yellow Taxi',
    description: 'Synthetic NYC taxi trip data - 19K points (Jan 15, 2024)',
    url: '/data/nyc-rideshare.stt',
    type: 'point',
    timeRange: {
      start: 1705276835000,  // Jan 15, 2024 00:00 UTC (from actual data)
      end: 1705365399000,    // Jan 15, 2024 ~24:36 UTC (from actual data)
    },
    timeWindow: 3600000, // 1 hour window for 24-hour data
    targetPlaybackSeconds: 120, // 1 day plays in 2 minutes
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 12,
      pitch: 45,
      bearing: 0
    },
    legend: {
      title: "Trip Status",
      items: [
        { color: "#4CAF50", label: "Pickup" },
        { color: "#2196F3", label: "En Route" },
        { color: "#FF5722", label: "Dropoff" }
      ]
    },
  },
  {
    id: 'nyc-taxi-paths',
    name: 'NYC Taxi Paths',
    description: 'Real TLC trip paths with OSRM routing - 500K trips from January 2015',
    url: '/data/nyc-taxi-paths.stt',
    type: 'path',
    timeRange: {
      start: 1420088400000,  // 2015-01-01 00:00:00 UTC
      end: 1422766799000,    // 2015-01-31 23:59:59 UTC
    },
    timeWindow: 3600000, // 1 hour window for month-long data
    targetPlaybackSeconds: 1200, // ~1 month plays in 10 minutes
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 13,
      pitch: 45,
      bearing: -15
    },
    legend: {
      title: "Taxi Trips",
      items: [
        { color: "#FFD700", label: "Active Trip" },
      ]
    },
  },
  {
    id: 'nyc-taxi-trips',
    name: 'NYC Taxi Trips',
    description: 'Animated taxi trips with trailing effect - 1M real routed trips from January 2015',
    url: '/data/nyc-taxi-paths.stt',
    type: 'trips',
    timeRange: {
      start: 1420070411000,  // From generated data (Jan 1, 2015)
      end: 1422751348000,    // From generated data (Jan 31, 2015)
    },
    timeWindow: 600000, // 10 min window - reduces memory usage with 1M trips
    targetPlaybackSeconds: 18200, // ~1 month plays in 2 hours - very slow/relaxed animation
    initialViewState: {
      longitude: -73.98,
      latitude: 40.75,
      zoom: 13,
      pitch: 45,
      bearing: -15
    },
    legend: {
      title: "Taxi Trips",
      items: [
        { color: "#FD805D", label: "Active Trip" },
      ]
    },
  },
  {
    id: 'ship-traffic',
    name: 'US Maritime Traffic',
    description: 'Real AIS data from NOAA Marine Cadastre - 1.3M points, 16K vessels, 24 hours',
    url: '/data/ais-all-us.stt',
    type: 'point',
    timeRange: {
      start: 1672531200000, // 2023-01-01T00:00:00Z
      end: 1672617599000,   // 2023-01-01T23:59:59Z
    },
    timeWindow: 1800000, // 30 minute window for 24-hour data
    targetPlaybackSeconds: 180, // 24 hours plays in 3 minutes
    initialViewState: {
      longitude: -95,
      latitude: 30,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Vessel Type",
      items: [
        { color: "#4A90E2", label: "Cargo" },
        { color: "#F5A623", label: "Tanker" },
        { color: "#50E3C2", label: "Passenger" },
        { color: "#B8E986", label: "Fishing" },
        { color: "#9B59B6", label: "Towing" },
        { color: "#808080", label: "Other" }
      ]
    },
  },
  {
    id: 'wildfires',
    name: 'US Wildfires',
    description: 'NIFC wildfire perimeters (1000+ acres, 2020-2023) - polygon data',
    url: '/data/wildfires.stt',
    type: 'polygon',
    timeRange: {
      start: 1590969600000, // 2020-06-01T00:00:00Z
      end: 1702339200000,   // 2023-12-11T00:00:00Z
    },
    timeWindow: 86400000 * 30, // 30 day window for multi-year data
    targetPlaybackSeconds: 120, // ~3.5 years plays in 2 minutes
    initialViewState: {
      longitude: -115,
      latitude: 40,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Fire Severity",
      items: [
        { color: "#FFEDA0", label: "Moderate (1K-10K acres)" },
        { color: "#FEB24C", label: "High (10K-50K acres)" },
        { color: "#F03B20", label: "Extreme (50K-100K acres)" },
        { color: "#BD0026", label: "Catastrophic (100K+ acres)" }
      ]
    },
  },
  {
    id: 'satellites',
    name: 'Satellite Orbits (Globe)',
    description: 'All active satellites from CelesTrak - 13,506 orbits on 3D globe',
    url: '/data/satellites.stt',
    type: 'trips', // Use trips layer for animated satellite movement
    useGlobe: true, // Render on 3D globe for orbital visualization
    timeRange: {
      start: 1718928000000, // 2024-06-21T00:00:00Z
      end: 1719014400000,   // 2024-06-22T00:00:00Z (24 hours)
    },
    // Time window controls which segments are loaded/visible
    // For LEO satellites with ~90 min orbits and ~40 min segments, use larger window
    timeWindow: 600000, // 10 minute window - loads segments overlapping this range
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes for smooth animation
    initialViewState: {
      longitude: 0,
      latitude: 20,
      zoom: 0.5,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Orbit Type",
      items: [
        { color: "#4FC3F7", label: "LEO (Low Earth Orbit)" },
        { color: "#FFB74D", label: "MEO (Medium Earth Orbit)" },
        { color: "#81C784", label: "GEO (Geostationary)" },
        { color: "#E57373", label: "HEO (High Earth Orbit)" }
      ]
    },
  },
  {
    id: 'satellite-trips-flat',
    name: 'Satellite Orbits (Flat Map)',
    description: 'All active satellites from CelesTrak - 13,506 animated orbits on flat projection',
    url: '/data/satellites.stt',
    type: 'trips', // Use trips layer for animated satellite movement
    timeRange: {
      start: 1718928000000, // 2024-06-21T00:00:00Z
      end: 1719014400000,   // 2024-06-22T00:00:00Z (24 hours)
    },
    // Time window controls which segments are loaded/visible
    // For LEO satellites with ~90 min orbits and ~40 min segments, use larger window
    timeWindow: 600000, // 10 minute window - loads segments overlapping this range
    targetPlaybackSeconds: 600, // 24 hours plays in 10 minutes for smooth animation
    initialViewState: {
      longitude: 0,
      latitude: 0,
      zoom: 1.2,
      pitch: 0,
      bearing: 0
    },
    legend: {
      title: "Orbit Type",
      items: [
        { color: "#4FC3F7", label: "LEO (Low Earth Orbit)" },
        { color: "#FFB74D", label: "MEO (Medium Earth Orbit)" },
        { color: "#81C784", label: "GEO (Geostationary)" },
        { color: "#E57373", label: "HEO (High Earth Orbit)" }
      ]
    },
  },
];

export const DATASETS = datasets;

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

export const defaultDatasetId = 'earthquake-activity';
