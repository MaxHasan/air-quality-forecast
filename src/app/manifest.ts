import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Air Quality Predictor',
    short_name: 'AQ Predict',
    description:
      "Wind-speed-driven PM2.5 forecasts for Jabodetabek, Bali and Singapore — plan a run, a swim, or a pram walk a day ahead.",
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f8fafc',
    theme_color: '#0d9488',
    lang: 'en',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
