import { clientOnlyRoute } from '../lib/clientOnlyRoute';
import type { MetaFunction } from 'react-router';
import { createSeoMeta } from '../lib/seo';

export const meta: MetaFunction = ({ location }) =>
  createSeoMeta({
    title: 'Cesium STT viewer',
    description:
      'Explore a SpatioTemporal Tiles dataset in the experimental fullscreen Cesium globe renderer.',
    path: location.pathname,
    noIndex: true,
  });

// CesiumJS (WGS84 globe) viewer — client-only, never prerendered. Lazy so
// Cesium stays out of the prerender bundle.
export default clientOnlyRoute(() => import('./CesiumDemoPageImpl'));
