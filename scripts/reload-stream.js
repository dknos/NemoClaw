#!/usr/bin/env node
// reload-stream.js
// Reload the stream browser page via Chrome DevTools Protocol (CDP)
// No stream restart — instant page reload while streaming continues

const http = require('http');

http.get('http://localhost:9222/json', res => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    try {
      const tabs = JSON.parse(data);
      const tab = tabs[0];
      if (!tab || !tab.webSocketDebuggerUrl) {
        console.error('❌ No active tab found. Is the stream running?');
        process.exit(1);
      }

      const ws = require('ws');
      const sock = new ws(tab.webSocketDebuggerUrl);

      sock.on('open', () => {
        console.log('✅ Connected to stream browser via CDP');
        sock.send(JSON.stringify({
          id: 1,
          method: 'Page.reload',
          params: { ignoreCache: true }
        }));
        console.log('🔄 Page reload command sent');
        setTimeout(() => {
          sock.close();
          console.log('✅ Stream page reloaded successfully');
          process.exit(0);
        }, 1000);
      });

      sock.on('error', err => {
        console.error('❌ WebSocket error:', err.message);
        process.exit(1);
      });
    } catch (err) {
      console.error('❌ Error:', err.message);
      process.exit(1);
    }
  });
});

http.get('http://localhost:9222/json', () => {}).on('error', _err => {
  console.error('❌ CDP not available. Is the stream running? (http://localhost:9222)');
  process.exit(1);
});
