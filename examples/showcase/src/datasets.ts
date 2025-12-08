/**
 * Dataset configurations for the spatiotemporal tiles showcase
 * 
 * Animation speed is now computed automatically based on targetPlaybackSeconds
 * to ensure consistent playback experience across all datasets.
 */

import { Dataset } from './types';

export const datasets: Dataset[] = [
  {
    id: 'covid-cases',
    name: 'COVID-19 Cases',
    description: 'NYT county-level data (5 sample counties) from Feb 2020 - May 2022',
    url: '/data/covid-cases.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2020-02-02T00:00:00.000Z'),
      end: Date.parse('2022-05-13T00:00:00.000Z'),
    },
    timeWindow: 86400000 * 7, // 1 week window for daily data spanning years
    targetPlaybackSeconds: 120, // ~2.5 years plays in 45 seconds
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
  },
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
    description: 'Simulated flight paths over continental US',
    url: '/data/flights.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2024-01-01T00:00:00.000Z'),
      end: Date.parse('2024-01-01T23:55:00.000Z'),
    },
    timeWindow: 3600000, // 1 hour window
    targetPlaybackSeconds: 120, // 1 day plays in 30 seconds
    initialViewState: {
      longitude: -98.5,
      latitude: 39.8,
      zoom: 4,
      pitch: 0,
      bearing: 0
    },
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
    id: 'sf-taxis',
    name: 'San Francisco Taxis',
    description: 'Simulated taxi trajectories in San Francisco',
    url: '/data/sf-taxis.stt',
    type: 'point',
    timeRange: {
      start: Date.parse('2024-01-15T00:00:00.000Z'),
      end: Date.parse('2024-01-15T23:59:00.000Z'),
    },
    timeWindow: 600000, // 10 minute window
    targetPlaybackSeconds: 120, // 1 day plays in 30 seconds
    initialViewState: {
      longitude: -122.43,
      latitude: 37.78,
      zoom: 12,
      pitch: 45,
      bearing: 0
    },
  },
  {
    id: 'nyc-rideshare',
    name: 'NYC Yellow Taxi',
    description: 'Real TLC trip data with OSRM-routed trajectories (Feb 2016)',
    url: '/data/nyc-rideshare.stt',
    type: 'point',
    timeRange: {
      start: 1454289023000,  // Feb 1, 2016
      end: 1456788582000,    // Feb 29, 2016
    },
    timeWindow: 3600000, // 1 hour window for month-long data
    targetPlaybackSeconds: 1200, // 1 month plays in 20 minutes
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
    id: 'ship-traffic',
    name: 'SF Bay Maritime Traffic',
    description: 'Real AIS data from NOAA Marine Cadastre - 229K points, 1 week',
    url: '/data/ais-sf-bay.stt',
    type: 'point',
    timeRange: {
      start: 1672531200000, // 2023-01-01T00:00:00Z
      end: 1673135998000,   // 2023-01-07T23:59:58Z
    },
    timeWindow: 3600000, // 1 hour window
    targetPlaybackSeconds: 120, // 1 week plays in 30 seconds
    initialViewState: {
      longitude: -122.4,
      latitude: 37.8,
      zoom: 10,
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
];

export const DATASETS = datasets;

export function getDatasetById(id: string): Dataset | undefined {
  return datasets.find(d => d.id === id);
}

export const defaultDatasetId = 'earthquake-activity';
