import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['*.localhost'],
  async rewrites() { return [{ source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' }]; },
};
export default config;

