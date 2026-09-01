const { createApp } = require('./app');
const { createStore } = require('./store');

async function main() {
  if (!process.env.PORTAL_PASSWORD) {
    throw new Error('PORTAL_PASSWORD must be configured');
  }
  const { store, close } = await createStore();
  const port = Number(process.env.PORT || 3000);
  const app = createApp({
    store,
    portalPassword: process.env.PORTAL_PASSWORD,
  });
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`DNSPortal mock listening on port ${port}`);
  });

  const shutdown = () => server.close(async () => {
    await close();
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
