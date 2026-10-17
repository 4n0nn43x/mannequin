/** @type {import('next').NextConfig} */
export default {
  // the engine runs on the Node server as is (SDKs with keep-alive sockets, files read from process.cwd())
  serverExternalPackages: ['stripe', 'openai', '@nodeops-createos/sandbox'],
}
