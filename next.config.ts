import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Caddy handles compression — disabling here prevents Next.js from
  // buffering ReadableStream responses (breaks NDJSON streaming).
  compress: false,
  // iOS reads the universal-links file as JSON; it has no extension, so the
  // type is set here instead of being guessed as application/octet-stream.
  async headers() {
    return [
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
    ];
  },
};

export default nextConfig;
