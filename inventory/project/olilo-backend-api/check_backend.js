import http from 'node:http';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8001';

console.log(`Checking backend connection at ${BACKEND_URL}...`);

const req = http.get(`${BACKEND_URL}/health`, (res) => {
  console.log(`Backend responded with status: ${res.statusCode}`);
  if (res.statusCode === 200 || res.statusCode === 404) {
    // 404 might be fine if /health doesn't exist but server is reachable
    console.log('✅ Backend is reachable.');
  } else {
    console.log('⚠️ Backend reachable but returned unexpected status.');
  }
  res.resume();
});

req.on('error', (e) => {
  console.error(`❌ Failed to connect to backend: ${e.message}`);
  console.error('Make sure the backend service is running on the expected port (default 8001).');
  process.exit(1);
});
