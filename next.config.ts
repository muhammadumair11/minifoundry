import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Phase 0: TypeScript is a hard gate now — tsconfig excludes the scaffold's
  // non-app folders (examples/, skills/), so `next build` fails on any app
  // type error. Keep it this way.
  reactStrictMode: false,
  // Keep the dev-tools bubble out of the sidebar's footer corner.
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
