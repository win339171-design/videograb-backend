const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'VideoGrab backend running' });
});

app.post('/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL လိုအပ်ပါတယ်' });

  try {
    const cmd = `yt-dlp -j --no-playlist --extractor-args "tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com" "${url}"`;
    const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 20, timeout: 60000 });
    const info = JSON.parse(stdout);

    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.url)
      .map(f => ({
        quality: f.height ? `${f.height}p` : (f.format_note || f.format_id),
        ext: f.ext,
        url: f.url,
        formatId: f.format_id,
        filesize: f.filesize || f.filesize_approx || (f.tbr ? Math.round(f.tbr * (info.duration || 10) * 128) : 0),
      }))
      .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      formats: formats.slice(0, 10),
      directUrl: info.url || (formats[0] && formats[0].url) || null,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Extract မအောင်မြင်ပါ', detail: err.message });
  }
});

const https = require('https');
const http = require('http');

app.get('/download', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'url parameter is required' });

  const client = videoUrl.startsWith('https') ? https : http;

  const proxyReq = client.get(videoUrl, (proxyRes) => {
    const upstreamType = proxyRes.headers['content-type'] || '';
    if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 206) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk; });
      proxyRes.on('end', () => {
        res.status(502).json({ error: 'Upstream fetch failed', code: proxyRes.statusCode, body: body.slice(0, 300) });
      });
      return;
    }
    if (!upstreamType.startsWith('video') && !upstreamType.startsWith('application/octet-stream')) {
      let body = '';
      proxyRes.on('data', chunk => { body += chunk; });
      proxyRes.on('end', () => {
        res.status(502).json({ error: 'Upstream returned non-video content', contentType: upstreamType, body: body.slice(0, 300) });
      });
      return;
    }
    res.setHeader('Content-Type', upstreamType || 'video/mp4');
    if (proxyRes.headers['content-length']) {
      res.setHeader('Content-Length', proxyRes.headers['content-length']);
    }
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  req.on('close', () => proxyReq.destroy());
});

app.get('/stream-progress', (req, res) => {
  const { url, formatId } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const os = require('os');
  const path = require('path');
  const fsSync = require('fs');

  const tempId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const tempPath = path.join(os.tmpdir(), `vg_${tempId}.mp4`);

  const fmtSelector = formatId
    ? `${formatId}+bestaudio/${formatId}/best`
    : 'bestvideo+bestaudio/best';

  const args = ['-f', fmtSelector, '--no-playlist', '--merge-output-format', 'mp4', '--newline', '-o', tempPath, url];
  const proc = require('child_process').spawn('yt-dlp', args);

  let stderrBuf = '';
  let lastPercent = -1;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/\[download\]\s+([\d.]+)%/);
    if (match) {
      const percent = Math.round(parseFloat(match[1]));
      if (percent !== lastPercent) {
        lastPercent = percent;
        res.write(`data: ${JSON.stringify({ percent, done: false })}\n\n`);
      }
    }
  });

  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  proc.on('close', (code) => {
    if (!fsSync.existsSync(tempPath)) {
      res.write(`data: ${JSON.stringify({ error: 'yt-dlp failed', code, detail: stderrBuf.slice(-300) })}\n\n`);
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ percent: 100, done: true, tempId })}\n\n`);
    res.end();
  });

  req.on('close', () => proc.kill());
});

app.get('/fetch-temp', (req, res) => {
  const { tempId } = req.query;
  if (!tempId) return res.status(400).json({ error: 'tempId required' });

  const os = require('os');
  const path = require('path');
  const fsSync = require('fs');
  const tempPath = path.join(os.tmpdir(), `vg_${tempId}.mp4`);

  if (!fsSync.existsSync(tempPath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }

  const stat = fsSync.statSync(tempPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

  const readStream = fsSync.createReadStream(tempPath);
  readStream.pipe(res);
  readStream.on('close', () => fsSync.unlink(tempPath, () => {}));
});

app.get('/stream', (req, res) => {
  const { url, formatId } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter is required' });

  const os = require('os');
  const path = require('path');
  const fsSync = require('fs');

  const tempId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const tempPath = path.join(os.tmpdir(), `vg_${tempId}.mp4`);

  const fmtSelector = formatId
    ? `${formatId}+bestaudio/${formatId}/best`
    : 'bestvideo+bestaudio/best';

  const args = ['-f', fmtSelector, '--no-playlist', '--merge-output-format', 'mp4', '-o', tempPath, url];
  const proc = require('child_process').spawn('yt-dlp', args);

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  proc.stdout.on('data', () => {});

  const cleanup = () => {
    fsSync.unlink(tempPath, () => {});
  };

  proc.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    cleanup();
  });

  proc.on('close', (code) => {
    if (!fsSync.existsSync(tempPath)) {
      if (!res.headersSent) {
        res.status(502).json({ error: 'yt-dlp failed to produce a file', code, detail: stderrBuf.slice(-500) });
      }
      cleanup();
      return;
    }

    const stat = fsSync.statSync(tempPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');

    const readStream = fsSync.createReadStream(tempPath);
    readStream.pipe(res);
    readStream.on('close', cleanup);
    readStream.on('error', cleanup);
  });

  req.on('close', () => {
    proc.kill();
    cleanup();
  });
});

app.get('/audio', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter is required' });

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');

  const cmd = `yt-dlp -f bestaudio --no-playlist -o - "${url}"`;
  const ytdlp = require('child_process').spawn('sh', ['-c', cmd]);
  const ffmpeg = require('child_process').spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-vn',
    '-acodec', 'libmp3lame',
    '-ab', '192k',
    '-f', 'mp3',
    'pipe:1'
  ]);

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdout.pipe(res);

  ytdlp.stderr.on('data', () => {});
  ffmpeg.stderr.on('data', () => {});

  ffmpeg.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  req.on('close', () => {
    ytdlp.kill();
    ffmpeg.kill();
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
