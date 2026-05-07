/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ignored: /node_modules/,
        poll: 1000,
        aggregateTimeout: 300,
      };
    }
    return config;
  },
}

module.exports = nextConfig