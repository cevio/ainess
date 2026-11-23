/** @type {import('next').NextConfig} */
const config = {
  distDir: 'dist',
  devIndicators: false,
  experimental: { turbopackFileSystemCacheForDev: false },
}

export default config
