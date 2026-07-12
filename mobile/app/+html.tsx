// mobile/app/+html.tsx
// Web HTML shell for expo-router STATIC rendering (web.output "static").
// NOTE: this project uses web.output "single", where Expo ignores +html.tsx and
// instead serves `public/index.html` (see mobile/public/index.html) — that file
// carries the live PWA head tags. This file is kept so the head stays correct if
// static rendering is ever enabled.
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>SplitEasy</title>
        <meta name="description" content="Split expenses with friends, effortlessly." />
        <meta name="theme-color" content="#5C7AEA" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="SplitEasy" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
