import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { YoutubeService } from '../src/main/youtube';
import { MediaProxy } from '../src/main/proxy';

async function main() {
  const videoId = 'rBlP6-fKgv0';
  const ytService = new YoutubeService();
  const proxy = new MediaProxy({
    getManifest: (id, force) => ytService.getManifest(id, force)
  });

  const proxyBase = await proxy.start();
  ytService.setProxyBase(proxyBase);
  console.log('MediaProxy started at:', proxyBase);

  const shakaJsPath = path.resolve('node_modules/shaka-player/dist/shaka-player.compiled.debug.js');
  const shakaJs = fs.readFileSync(shakaJsPath, 'utf-8');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/shaka.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(shakaJs);
      return;
    }

    if (req.url === '/' || req.url === '/index.html') {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Shaka HLS Live Stream Test</title>
  <script src="/shaka.js"></script>
</head>
<body style="background:#0f0f0f;color:#f1f1f1;font-family:sans-serif;padding:20px;margin:0;">
  <div style="max-width:960px;margin:0 auto;">
    <h1 style="font-size:22px;margin-bottom:12px;color:#fff;">Shaka HLS Live Stream Test</h1>
    <video id="video" width="960" height="540" controls autoplay muted style="background:#000;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.5);"></video>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;">
      <span id="liveBadge" style="background:#e00;color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:12px;">LIVE</span>
      <span id="statusInfo" style="font-size:13px;color:#aaa;">Connecting…</span>
      <button onclick="goToLiveEdge()" style="background:#272727;color:#fff;border:1px solid #444;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Go to Live Edge</button>
      <button onclick="unmute()" style="background:#272727;color:#fff;border:1px solid #444;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">Unmute Audio</button>
    </div>
    <h3 style="margin-top:20px;font-size:14px;color:#888;">Player Events & Logs</h3>
    <pre id="log" style="background:#181818;border:1px solid #282828;border-radius:6px;padding:12px;height:240px;overflow:auto;font-size:12px;line-height:1.5;color:#bbb;"></pre>
  </div>
  <script>
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('statusInfo');
    function log(...args) {
      console.log(...args);
      logEl.textContent += args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\\n';
      logEl.scrollTop = logEl.scrollHeight;
    }

    function goToLiveEdge() {
      if (!window.player || !window.video) return;
      const range = window.player.seekRange();
      const target = Math.max(range.start, range.end - 2);
      window.video.currentTime = target;
      log('Jumped to live edge:', target.toFixed(1));
    }

    function unmute() {
      if (!window.video) return;
      window.video.muted = false;
      window.video.volume = 1;
      log('Unmuted audio');
    }

    async function init() {
      try {
        shaka.polyfill.installAll();
        const video = document.getElementById('video');
        const player = new shaka.Player();
        window.player = player;
        window.video = video;
        await player.attach(video);

        player.configure({
          streaming: {
            rebufferingGoal: 2,
            bufferingGoal: 10,
            bufferBehind: 15,
            safeSeekEndOffset: 2,
            returnToEndOfLiveWindowWhenOutside: true,
            stallThreshold: 2,
            stallEnabled: true
          },
          manifest: {
            disableText: true,
            disableIFrames: true,
            disableThumbnails: true,
            hls: { sequenceMode: false, liveSegmentsDelay: 2 }
          }
        });

        player.addEventListener('error', (e) => log('PLAYER ERROR:', e.detail));
        player.addEventListener('buffering', (e) => {
          log('BUFFERING:', e.buffering);
          statusEl.textContent = e.buffering ? 'Buffering…' : 'Playing';
        });

        const manifestUrl = '${proxyBase}/manifest?id=${videoId}';
        log('Loading HLS live manifest:', manifestUrl);
        await player.load(manifestUrl, -2);
        log('HLS Live Manifest Loaded! isLive:', player.isLive());

        const range = player.seekRange();
        log('Seek range:', range.start.toFixed(1), '->', range.end.toFixed(1));

        video.addEventListener('playing', () => {
          log('EVENT: playing at', video.currentTime.toFixed(1));
          statusEl.textContent = 'Playing';
        });

        video.addEventListener('timeupdate', () => {
          const r = player.seekRange();
          const behind = Math.max(0, r.end - video.currentTime);
          statusEl.textContent = 'Playing (' + behind.toFixed(1) + 's behind live edge)';
        });

        video.muted = true;
        await video.play();
      } catch (err) {
        log('INIT ERROR:', err.message, err.stack);
        statusEl.textContent = 'Error: ' + err.message;
      }
    }
    init();
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(4001, '127.0.0.1', () => {
    console.log('HLS Test server running at http://127.0.0.1:4001');
  });
}

main().catch(console.error);
