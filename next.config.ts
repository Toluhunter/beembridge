import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  output: 'export', // This exports the Next.js app as static HTML/CSS/JS
  distDir: 'dist/renderer', // Output directory for the Next.js build
  assetPrefix: '/',
};

export default nextConfig;
