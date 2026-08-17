import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { PreferencesProvider } from '@/components/PreferencesProvider';
import { IngestionFooter } from '@/components/IngestionFooter';
import { getIngestionHealth } from '@/lib/data';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  // The deployed origin. Every relative URL in metadata — canonical links,
  // Open Graph and Twitter images — is resolved against this.
  //
  // It previously read `air-quality-predictor.vercel.app`, which is NOT this
  // app: that subdomain was already claimed by an unrelated create-react-app
  // project. `.vercel.app` is one global first-come namespace, so an
  // unverified guess at your own hostname can quietly point your metadata at a
  // stranger's site.
  metadataBase: new URL('https://air-quality-forecast.vercel.app'),
  title: {
    default: 'Air Quality Forecast',
    template: '%s · Air Quality Forecast',
  },
  description:
    "Wind-speed-driven PM2.5 forecasts for Jabodetabek, Bali and Singapore — plan a run, a swim, or a stroller walk a day ahead.",
  applicationName: 'Air Quality Forecast',
  icons: {
    icon: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d9488',
  colorScheme: 'light dark',
};

const NAV_LINKS = [
  { href: '/', label: 'Forecasts' },
  { href: '/models', label: 'Model accuracy' },
  { href: '/about', label: 'About' },
];

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const health = await getIngestionHealth();

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} flex min-h-screen flex-col antialiased`}>
        <PreferencesProvider>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-1.5 focus:text-accent-foreground"
          >
            Skip to content
          </a>
          <nav className="border-b border-surface-border bg-surface">
            <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
              <Link href="/" className="flex items-center gap-2 font-semibold">
                <span aria-hidden>🌬️</span> Air Quality Forecast
              </Link>
              <div className="flex gap-4 text-sm">
                {NAV_LINKS.map((l) => (
                  <Link key={l.href} href={l.href} className="text-muted hover:text-accent">
                    {l.label}
                  </Link>
                ))}
              </div>
            </div>
          </nav>
          <div id="main" className="flex-1">
            {children}
          </div>
          <IngestionFooter health={health} />
        </PreferencesProvider>
      </body>
    </html>
  );
}
