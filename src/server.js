const { AGENT_TOKEN, PORT } = require('./config');
const Agent = require('./lib/Agent');
const WireGuard = require('./services/WireGuard');

// Print Universal Node Banner
const printNodeBanner = () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 AMNEZIAWG UNIVERSAL NODE IS READY');
  console.log('='.repeat(60));
  console.log(`🌍 Web UI Dashboard: http://your-server-ip:${PORT}`);
  console.log(`🔑 SECRET AGENT TOKEN: ${AGENT_TOKEN}`);
  console.log(`📡 Management Port: 161 (TCP)`);
  console.log('='.repeat(60));
  console.log('Use the SECRET AGENT TOKEN above to link this node to any other Hub.');
  console.log('='.repeat(60) + '\n');
};

// Start Agent Service (Port 161)
Agent.start();

// Start Hub Service (Web UI + WireGuard)
require('./services/Server');

WireGuard.getConfig()
  .then(() => {
    printNodeBanner();
  })
  .catch((err) => {
    console.error('Failed to initialize WireGuard:', err);
    process.exit(1);
  });

// Handle terminate signal
process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM signal received.');
  await WireGuard.Shutdown();
  // eslint-disable-next-line no-process-exit
  process.exit(0);
});

// Handle interrupt signal
process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.log('SIGINT signal received.');
});
