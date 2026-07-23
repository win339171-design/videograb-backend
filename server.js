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
    const cmd = `yt-dlp -j --no-playlist "${url}"`;
    const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 20, timeout: 60000 });
    const info = JSON.parse(stdout);

    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
      .map(f => ({
        quality: f.format_note || f.height ? `${f.height}p` : f.format_id,
        ext: f.ext,
        url: f.url,
        filesize: f.filesize || f.filesize_approx || 0,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
