const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
fs.mkdir(DOWNLOADS_DIR, { recursive: true }).catch(() => {});

const downloadLinks = new Map();

// Cleanup setiap 30 menit
setInterval(async () => {
    const now = Date.now();
    for (const [id, data] of downloadLinks.entries()) {
        if (now - data.timestamp > 1800000) {
            try {
                await fs.unlink(data.filePath).catch(() => {});
                downloadLinks.delete(id);
            } catch (e) {}
        }
    }
}, 1800000);

// Fungsi exec dengan promise
function execPromise(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

app.post('/api/convert', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, message: 'URL kosong' });
    }

    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
    if (!youtubeRegex.test(url)) {
        return res.status(400).json({ success: false, message: 'URL YouTube tidak valid' });
    }

    const conversionId = uuidv4();
    const outputTemplate = path.join(DOWNLOADS_DIR, `${conversionId}.%(ext)s`);
    const finalFile = path.join(DOWNLOADS_DIR, `${conversionId}.mp3`);

    try {
        console.log(`\n[CONVERT] Mulai: ${url}`);

        // Step 1: Get video info
        console.log('[INFO] Mengambil info video...');
        const { stdout: infoJson } = await execPromise(
            `yt-dlp --dump-json --no-playlist "${url}"`,
            { timeout: 30000 }
        );
        const info = JSON.parse(infoJson);
        console.log(`[INFO] Judul: ${info.title}`);
        console.log(`[INFO] Durasi: ${info.duration} detik`);
        console.log(`[INFO] Uploader: ${info.uploader || info.channel}`);

        // Step 2: Download & convert
        console.log('[DOWNLOAD] Mendownload & mengkonversi...');
        const command = `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${outputTemplate}" --no-playlist "${url}"`;
        
        await execPromise(command, { 
            timeout: 120000, 
            maxBuffer: 1024 * 1024 * 10 
        });

        console.log('[DOWNLOAD] Selesai!');

        // Cek file
        const stats = await fs.stat(finalFile);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);

        // Simpan info
        downloadLinks.set(conversionId, {
            url,
            timestamp: Date.now(),
            filePath: finalFile,
            title: info.title,
        });

        console.log(`[DONE] ${info.title} (${fileSizeMB} MB)`);

        res.json({
            success: true,
            data: {
                id: conversionId,
                title: info.title,
                thumbnail: info.thumbnail || '',
                duration: info.duration || 0,
                author: info.uploader || info.channel || 'Unknown',
                downloadUrl: `/api/download/${conversionId}`,
                quality: '320kbps',
                size: `${fileSizeMB} MB`,
            }
        });

    } catch (error) {
        console.error('[ERROR]', error.message);
        await fs.unlink(finalFile).catch(() => {});
        
        let msg = 'Gagal konversi';
        if (error.message.includes('Video unavailable')) msg = 'Video tidak tersedia';
        else if (error.message.includes('Private')) msg = 'Video private';
        else if (error.killed) msg = 'Timeout, video terlalu panjang';
        
        res.status(500).json({ success: false, message: msg });
    }
});

app.get('/api/download/:id', async (req, res) => {
    const data = downloadLinks.get(req.params.id);
    if (!data) {
        return res.status(404).json({ success: false, message: 'File kadaluarsa' });
    }

    try {
        const stat = await fs.stat(data.filePath);
        const safeName = data.title.replace(/[^a-zA-Z0-9\s]/g, '').substring(0, 100);
        
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp3"`);
        res.setHeader('Content-Length', stat.size);
        
        require('fs').createReadStream(data.filePath).pipe(res);
        console.log(`[DOWNLOAD] ${safeName}.mp3`);
    } catch (e) {
        console.error('[DOWNLOAD ERROR]', e.message);
        res.status(500).json({ success: false, message: 'File error' });
    }
});

app.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════╗
    ║     🎵 AudioVibe Server Running 🎵      ║
    ║══════════════════════════════════════════║
    ║  Server:  http://localhost:${PORT}          ║
    ║  API:     http://localhost:${PORT}/api      ║
    ╚══════════════════════════════════════════╝
    `);
});