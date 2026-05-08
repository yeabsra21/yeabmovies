require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
    SOURCE_CHANNEL: parseInt(process.env.SOURCE_CHANNEL) || 0,
    STORAGE_CHANNELS: (() => {
        try {
            return JSON.parse(process.env.STORAGE_CHANNELS || '{}');
        } catch (e) {
            return {};
        }
    })(),
    MIN_MOVIE_SIZE: (parseInt(process.env.MIN_MOVIE_SIZE_MB) || 50) * 1024 * 1024,
    DB_FILE: path.join(__dirname, 'movies.json')
};

// ============================================
// DATABASE
// ============================================
class Database {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            }
        } catch (e) {}
        return { movies: {}, stats: { totalUploads: 0, totalDownloads: 0 } };
    }

    save() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    addMovie(movieData) {
        const id = `MOV${String(Object.keys(this.data.movies).length + 1000).padStart(4, '0')}`;
        movieData.id = id;
        movieData.date = new Date().toISOString();
        movieData.downloads = 0;
        this.data.movies[id] = movieData;
        this.data.stats.totalUploads++;
        this.save();
        return id;
    }
}

const db = new Database(CONFIG.DB_FILE);

// ============================================
// SIMPLE CATEGORY DETECTION
// ============================================
function detectCategory(text) {
    if (!text) return 'default';
    const t = text.toLowerCase();
    
    if (/s\d|season|episode|web.series/i.test(t)) return 'web_series';
    if (/anime|japanese|subbed/i.test(t)) return 'anime';
    if (/dual.audio|multi.audio|hin.eng|eng.hin/i.test(t)) return 'dual_audio';
    if (/hindi|bollywood|hindi.dubbed/i.test(t)) return 'bollywood';
    if (/english|eng|hollywood/i.test(t)) return 'hollywood';
    if (new Date().getFullYear().toString().includes(t)) return 'new_releases';
    return 'default';
}

function extractInfo(text) {
    const info = { title: '', year: '', quality: 'Unknown', language: 'Unknown', size: 'Unknown' };
    if (!text) return info;
    const t = text.toLowerCase();
    
    if (/2160p|4k|uhd/i.test(t)) info.quality = '4K';
    else if (/1080p|full hd|fhd|bluray/i.test(t)) info.quality = '1080p';
    else if (/720p|hd|hdrip/i.test(t)) info.quality = '720p';
    else if (/480p|sd/i.test(t)) info.quality = '480p';
    
    const yearMatch = text.match(/(19|20)\d{2}/);
    if (yearMatch) info.year = yearMatch[0];
    
    const sizeMatch = text.match(/(\d+\.?\d*)\s*(GB|MB)/i);
    if (sizeMatch) info.size = sizeMatch[1] + sizeMatch[2].toUpperCase();
    
    if (/hindi|bollywood/i.test(t)) info.language = 'Hindi';
    else if (/english|eng/i.test(t)) info.language = 'English';
    else if (/dual/i.test(t)) info.language = 'Dual Audio';
    
    let title = text.split('\n')[0] || '';
    ['🎬','🎥','📺','🔥','💥','⚡','✅','👉','•','🎯'].forEach(e => title = title.replace(e, ''));
    if (info.year) title = title.replace(info.year, '');
    info.title = title.trim().substring(0, 200);
    
    return info;
}

// ============================================
// INITIALIZE BOT
// ============================================
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// ============================================
// DEBUG: Log ALL incoming messages
// ============================================
bot.on('message', (msg) => {
    console.log('\n📨 MESSAGE RECEIVED:');
    console.log('   Chat ID:', msg.chat.id);
    console.log('   Chat Type:', msg.chat.type);
    console.log('   Is Channel Post:', msg.chat.type === 'channel');
    console.log('   Has Video:', !!msg.video);
    console.log('   Has Document:', !!msg.document);
    console.log('   Has Caption:', !!msg.caption);
    console.log('   Caption Text:', msg.caption || 'NONE');
    console.log('   Source Channel:', CONFIG.SOURCE_CHANNEL);
    console.log('   Match Source:', msg.chat.id === CONFIG.SOURCE_CHANNEL);
    
    if (msg.video) {
        console.log('   Video File Size:', msg.video.file_size, 'bytes');
        console.log('   Video Size MB:', (msg.video.file_size / (1024 * 1024)).toFixed(2), 'MB');
        console.log('   Min Size Required:', CONFIG.MIN_MOVIE_SIZE, 'bytes');
        console.log('   Size Check Passed:', msg.video.file_size >= CONFIG.MIN_MOVIE_SIZE);
    }
    if (msg.document) {
        console.log('   Document File Size:', msg.document.file_size, 'bytes');
        console.log('   Document Size MB:', (msg.document.file_size / (1024 * 1024)).toFixed(2), 'MB');
    }
});

// ============================================
// CHANNEL POST HANDLER (Auto-Upload)
// ============================================
bot.on('channel_post', async (msg) => {
    console.log('\n🎬 CHANNEL POST DETECTED!');
    console.log('   Message ID:', msg.message_id);
    console.log('   Chat ID:', msg.chat.id);
    console.log('   SOURCE_CHANNEL config:', CONFIG.SOURCE_CHANNEL);
    console.log('   Match:', msg.chat.id === CONFIG.SOURCE_CHANNEL);
    
    // Check if from source channel
    if (msg.chat.id !== CONFIG.SOURCE_CHANNEL) {
        console.log('   ❌ SKIPPED: Not from source channel');
        return;
    }
    
    console.log('   ✅ From source channel!');
    
    // Check if video or document
    if (!msg.video && !msg.document) {
        console.log('   ❌ SKIPPED: No video or document');
        return;
    }
    
    console.log('   ✅ Has video/document!');
    
    // Check file size
    const fileSize = msg.video?.file_size || msg.document?.file_size || 0;
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    console.log('   File Size:', sizeMB, 'MB');
    console.log('   Min Required:', (CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0), 'MB');
    
    if (fileSize < CONFIG.MIN_MOVIE_SIZE) {
        console.log('   ❌ SKIPPED: File too small');
        await bot.sendMessage(CONFIG.ADMIN_IDS[0], 
            `⚠️ File too small: ${sizeMB}MB\nMinimum required: ${(CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0)}MB`
        ).catch(() => {});
        return;
    }
    
    console.log('   ✅ File size OK!');
    
    try {
        // Get caption
        let caption = msg.caption || '';
        if (!caption) {
            caption = msg.video?.file_name || msg.document?.file_name || `Movie_${msg.message_id}`;
        }
        
        console.log('   Caption:', caption);
        
        // Detect category
        const category = detectCategory(caption);
        console.log('   Category detected:', category);
        
        // Get storage channel
        const storageId = CONFIG.STORAGE_CHANNELS[category] || CONFIG.STORAGE_CHANNELS['default'];
        console.log('   Storage channel ID:', storageId);
        console.log('   All storage channels:', CONFIG.STORAGE_CHANNELS);
        
        if (!storageId) {
            console.log('   ❌ No storage channel found!');
            await bot.sendMessage(CONFIG.ADMIN_IDS[0],
                `❌ No storage channel for category: ${category}\n\nAvailable: ${JSON.stringify(CONFIG.STORAGE_CHANNELS)}`
            ).catch(() => {});
            return;
        }
        
        // Try to forward
        console.log('   🔄 Attempting to forward...');
        console.log('   From:', CONFIG.SOURCE_CHANNEL);
        console.log('   To:', storageId);
        console.log('   Message ID:', msg.message_id);
        
        const sent = await bot.forwardMessage(storageId, CONFIG.SOURCE_CHANNEL, msg.message_id);
        console.log('   ✅ Forwarded successfully!');
        console.log('   New Message ID:', sent.message_id);
        
        // Extract info
        const info = extractInfo(caption);
        
        // Save to database
        const movieData = {
            title: info.title || `Movie_${msg.message_id}`,
            year: info.year,
            quality: info.quality,
            language: info.language,
            size: info.size || `${sizeMB}MB`,
            category: category,
            channelIds: [storageId],
            messageIds: [sent.message_id],
            plot: caption.substring(0, 500)
        };
        
        const movieId = db.addMovie(movieData);
        console.log('   🎉 Movie saved as:', movieId);
        
        // Notify admin
        await bot.sendMessage(CONFIG.ADMIN_IDS[0],
            `✅ *Auto-Uploaded!*\n\n` +
            `🎬 *${movieData.title}*\n` +
            `📊 ${movieData.quality} | ${movieData.size}\n` +
            `📂 ${category}\n` +
            `🆔 ${movieId}`,
            { parse_mode: 'Markdown' }
        );
        console.log('   ✅ Admin notified!');
        
    } catch (error) {
        console.log('   ❌ ERROR:', error.message);
        console.log('   Full error:', error);
        
        await bot.sendMessage(CONFIG.ADMIN_IDS[0],
            `❌ *Auto-upload failed!*\n\n` +
            `Error: ${error.message}\n\n` +
            `Category: ${detectCategory(msg.caption || '')}\n` +
            `Storage ID: ${CONFIG.STORAGE_CHANNELS[detectCategory(msg.caption || '')] || 'Not found'}`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
});

// /start command
bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `🎬 *Movie Bot is Running!*\n\n` +
        `📦 Movies: ${db.data.stats.totalUploads}\n` +
        `📥 Downloads: ${db.data.stats.totalDownloads}\n\n` +
        `Just type a movie name to search!`,
        { parse_mode: 'Markdown' }
    );
});

// /admin command
bot.onText(/\/admin/, async (msg) => {
    if (!CONFIG.ADMIN_IDS.includes(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, '⛔ Admin only!');
    }
    
    await bot.sendMessage(msg.chat.id,
        `🔧 *Admin Panel*\n\n` +
        `📦 Movies: ${db.data.stats.totalUploads}\n` +
        `📡 Source: ${CONFIG.SOURCE_CHANNEL}\n` +
        `🗂 Storage: ${Object.keys(CONFIG.STORAGE_CHANNELS).filter(k => CONFIG.STORAGE_CHANNELS[k]).length} channels\n` +
        `💾 Min Size: ${(CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0)}MB`,
        { parse_mode: 'Markdown' }
    );
});

// Text search
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/') || msg.chat.type === 'channel') return;
    
    const query = msg.text.toLowerCase();
    const results = Object.entries(db.data.movies)
        .filter(([_, m]) => (m.title || '').toLowerCase().includes(query))
        .map(([id, m]) => ({ id, ...m }))
        .slice(0, 10);
    
    if (results.length === 0) {
        return bot.sendMessage(msg.chat.id, `❌ No results for: ${msg.text}`);
    }
    
    let reply = `🔍 Results: ${msg.text}\n\n`;
    results.forEach((m, i) => {
        reply += `${i + 1}. ${m.title} (${m.year || 'N/A'})\n   /get_${m.id}\n\n`;
    });
    
    await bot.sendMessage(msg.chat.id, reply);
});

// /get_MOVIEID
bot.onText(/\/get_(\w+)/, async (msg, match) => {
    const movieId = match[1];
    const movie = db.data.movies[movieId];
    
    if (!movie) return bot.sendMessage(msg.chat.id, '❌ Movie not found!');
    
    const channelIds = movie.channelIds || [];
    const messageIds = movie.messageIds || [];
    
    for (let i = 0; i < channelIds.length; i++) {
        try {
            await bot.forwardMessage(msg.chat.id, channelIds[i], messageIds[i]);
            movie.downloads = (movie.downloads || 0) + 1;
            db.data.stats.totalDownloads++;
            db.save();
            return bot.sendMessage(msg.chat.id, `✅ Sent: ${movie.title}`);
        } catch (e) {
            continue;
        }
    }
    
    bot.sendMessage(msg.chat.id, '❌ Failed to send movie.');
});

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

// ============================================
// STARTUP
// ============================================
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║     🎬 DEBUG MODE - MOVIE BOT      ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log('📡 Source Channel:', CONFIG.SOURCE_CHANNEL);
console.log('🗂 Storage Channels:');
Object.entries(CONFIG.STORAGE_CHANNELS).forEach(([name, id]) => {
    console.log(`   • ${name}: ${id}`);
});
console.log('👑 Admin IDs:', CONFIG.ADMIN_IDS);
console.log('💾 Min File Size:', (CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0), 'MB');
console.log('');
console.log('✅ Bot is running! Waiting for posts...');
console.log('');
