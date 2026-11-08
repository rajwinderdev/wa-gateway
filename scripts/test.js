#!/usr/bin/env node
/**
 * Test script for WhatsApp Gateway
 * Hits /health, tests API key authentication, starts a session,
 * and outputs the QR code (saves as qr.png and displays info).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const TEST_SESSION = process.env.SESSION_KEY || 'session_demo_1';

async function runTest() {
  console.log(`\n========================================`);
  console.log(`Testing WhatsApp Gateway at ${BASE_URL}`);
  console.log(`========================================\n`);

  try {
    // 1. Test /health
    console.log(`[1] Testing GET /health...`);
    const healthRes = await axios.get(`${BASE_URL}/health`);
    console.log(`✓ Health response:`, JSON.stringify(healthRes.data));

    // 2. Test /sessions/start
    console.log(`\n[2] Starting or fetching session "${TEST_SESSION}" via POST /sessions/start...`);
    const startRes = await axios.post(
      `${BASE_URL}/sessions/start`,
      { session_key: TEST_SESSION },
      { headers: { 'X-API-KEY': API_KEY } }
    );
    console.log(`✓ Start response status: ${startRes.data.status}`);

    if (startRes.data.qr) {
      const qrDataUrl = startRes.data.qr;
      console.log(`\n✓ QR Code received! (Base64 length: ${qrDataUrl.length})`);

      // Extract base64 image data and save as qr.png
      const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
      const outPath = path.join(__dirname, '..', 'qr.png');
      fs.writeFileSync(outPath, base64Data, 'base64');
      console.log(`\n📸 QR Code saved to file: ${outPath}`);
      console.log(`Open qr.png on your computer or device and scan it with WhatsApp!`);
    } else if (startRes.data.status === 'connected') {
      console.log(`✓ Session is already connected as: ${startRes.data.phone || 'Unknown'} (${startRes.data.name || ''})`);
    } else {
      console.log(`Current status: ${startRes.data.status}. Polling status in 3s...`);
    }

    // 3. Test /sessions/:session_key/status
    console.log(`\n[3] Checking status via GET /sessions/${TEST_SESSION}/status...`);
    const statusRes = await axios.get(`${BASE_URL}/sessions/${TEST_SESSION}/status`, {
      headers: { 'X-API-KEY': API_KEY }
    });
    console.log(`✓ Status check:`, JSON.stringify(statusRes.data));

    console.log(`\n========================================`);
    console.log(`Tests completed successfully.`);
    console.log(`========================================\n`);
  } catch (error) {
    if (error.response) {
      console.error(`✗ Request failed with status ${error.response.status}:`, error.response.data);
    } else {
      console.error(`✗ Network or execution error:`, error.message);
    }
    process.exit(1);
  }
}

runTest();
