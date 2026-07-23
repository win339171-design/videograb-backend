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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
