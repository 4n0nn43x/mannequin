/** @type {import('next').NextConfig} */
export default {
  // the engine runs on the Node server as is (SDKs with keep-alive sockets); VM files are embedded (assets.gen.ts)
  serverExternalPackages: ['stripe', 'openai', '@nodeops-createos/sandbox'],
  output: process.env.NEXT_STANDALONE ? 'standalone' : undefined, // set by the Dockerfile
}
