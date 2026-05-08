// ============================================
// TELEGRAM MOVIE BOT - RENDER READY
// ============================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    
    ADMIN_IDS: (process.env.ADMIN_IDS || '7078087763').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
    
    SOURCE_CHANNEL: parseInt(process.env.SOURCE_CHANNEL) || -1002442336529,
    
    // Hardcoded storage channels (backup if env var fails)
    STORAGE_CHANNELS: (() => {
        try {
            const channels = JSON.parse(process.env.STORAGE_CHANNELS || '{}');
            if (Object.keys(channels).length > 0) {
                console.log('📂 Using environment variable storage channels');
                return channels;
            }
        } catch (e) {
            console.log('⚠️ Error parsing env STORAGE_CHANNELS');
        }
        // Hardcoded fallback
        console.log('📂 Using hardcoded storage channels');
        return {
            "hollywood": -1003368223980,
            "bollywood": -1003267382963,
            "dual_audio": -1003362847566,
            "default": -1003171355952
        };
    })(),
    
    TMDB_API_KEY: process.env.TMDB_API_KEY || '',
    AUTO_UPLOAD: process.env.AUTO_UPLOAD_ENABLED !== 'false',
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
        } catch (e) {
            console.error('Database load error:', e.message);
        }
        return { movies: {}, stats: { totalUploads: 0, totalDownloads: 0 } };
    }

    save() {
        try {
            this.data.stats.lastUpdate = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error('Database save error:', e.message);
        }
    }

    addMovie(movieData) {
        const id = `MOV${String(Object.keys(this.data.movies).length + 1000).padStart(4, '0')}`;
        movieData.id = id;
        movieData.addedDate = new Date().toISOString();
        movieData.downloads = 0;
        this.data.movies[id] = movieData;
        this.data.stats.totalUploads++;
        this.save();
        return id;
    }

    getMovie(id) {
        return this.data.movies[id] || null;
    }

    searchMovies(query, limit = 20) {
        const q = query.toLowerCase().trim();
        const results = [];
        for (const [id, movie] of Object.entries(this.data.movies)) {
            const searchText = `${movie.title || ''} ${movie.year || ''} ${movie.language || ''} ${movie.category || ''}`.toLowerCase();
            if (searchText.includes(q)) {
                results.push({ id, ...movie });
            }
        }
        results.sort((a, b) => b.downloads - a.downloads);
        return results.slice(0, limit);
    }

    getByCategory(category, limit = 20) {
        const results = [];
        for (const [id, movie] of Object.entries(this.data.movies)) {
            if (movie.category === category) {
                results.push({ id, ...movie });
            }
        }
        results.sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate));
        return results.slice(0, limit);
    }

    getTrending(limit = 10) {
        return Object.entries(this.data.movies)
            .map(([id, movie]) => ({ id, ...movie }))
            .sort((a, b) => b.downloads - a.downloads)
            .slice(0, limit);
    }

    incrementDownloads(id) {
        if (this.data.movies[id]) {
            this.data.movies[id].downloads = (this.data.movies[id].downloads || 0) + 1;
            this.data.stats.totalDownloads++;
            this.save();
        }
    }

    getStats() {
        const categories = {};
        for (const movie of Object.values(this.data.movies)) {
            const cat = movie.category || 'unknown';
            categories[cat] = (categories[cat] || 0) + 1;
        }
        return {
            totalMovies: Object.keys(this.data.movies).length,
            totalDownloads: this.data.stats.totalDownloads,
            categories
        };
    }
}

// ============================================
// CATEGORY DETECTION
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
    else if (/1080p|full.hd|fhd|bluray/i.test(t)) info.quality = '1080p';
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
    title = title.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    info.title = title.substring(0, 200);
    
    return info;
}

// ============================================
// INITIALIZE BOT & DATABASE
// ============================================
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new Database(CONFIG.DB_FILE);

// ============================================
// NOTIFY ADMIN
// ============================================
async function notifyAdmin(message) {
    try {
        for (const adminId of CONFIG.ADMIN_IDS) {
            await bot.sendMessage(adminId, message, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Failed to notify admin:', e.message);
    }
}

// ============================================
// AUTO-UPLOAD HANDLER
// ============================================
bot.on('channel_post', async (msg) => {
    console.log('\n🎬 CHANNEL POST DETECTED!');
    console.log('   Chat ID:', msg.chat.id);
    console.log('   Source:', CONFIG.SOURCE_CHANNEL);
    
    if (!CONFIG.AUTO_UPLOAD) {
        console.log('   ❌ Auto-upload disabled');
        return;
    }
    
    if (msg.chat.id !== CONFIG.SOURCE_CHANNEL) {
        console.log('   ❌ Not from source channel');
        return;
    }
    
    if (!msg.video && !msg.document) {
        console.log('   ❌ No video/document');
        return;
    }
    
    const fileSize = msg.video?.file_size || msg.document?.file_size || 0;
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    console.log('   File Size:', sizeMB, 'MB');
    
    if (fileSize < CONFIG.MIN_MOVIE_SIZE) {
        console.log('   ❌ Too small (min:', (CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0), 'MB)');
        await notifyAdmin(`⚠️ File too small: ${sizeMB}MB\nMinimum: ${(CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0)}MB`).catch(() => {});
        return;
    }
    
    console.log('   ✅ Size OK!');
    
    try {
        let caption = msg.caption || '';
        if (!caption) {
            caption = msg.video?.file_name || msg.document?.file_name || `Movie_${msg.message_id}`;
        }
        console.log('   Caption:', caption);
        
        const category = detectCategory(caption);
        console.log('   Category:', category);
        
        const storageId = CONFIG.STORAGE_CHANNELS[category] || CONFIG.STORAGE_CHANNELS['default'];
        console.log('   Storage ID:', storageId);
        console.log('   Available channels:', CONFIG.STORAGE_CHANNELS);
        
        if (!storageId) {
            console.log('   ❌ No storage channel!');
            await notifyAdmin(`❌ No storage channel for: ${category}\n\nAvailable: ${JSON.stringify(CONFIG.STORAGE_CHANNELS)}`).catch(() => {});
            return;
        }
        
        console.log('   🔄 Forwarding...');
        const sent = await bot.forwardMessage(storageId, CONFIG.SOURCE_CHANNEL, msg.message_id);
        console.log('   ✅ Forwarded! New ID:', sent.message_id);
        
        const info = extractInfo(caption);
        
        const movieData = {
            title: info.title || caption.replace(/\.[^.]+$/, ''),
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
        console.log('   🎉 Saved as:', movieId);
        
        await notifyAdmin(
            `✅ *Movie Auto-Uploaded!*\n\n` +
            `🎬 *${movieData.title}*\n` +
            `📊 ${movieData.quality} | ${movieData.size}\n` +
            `📂 ${category}\n🆔 ${movieId}\n\n` +
            `📦 Total: ${db.data.stats.totalUploads}`
        );
        
    } catch (error) {
        console.error('   ❌ Error:', error.message);
        await notifyAdmin(`❌ *Upload Failed!*\n\nError: ${error.message}`).catch(() => {});
    }
});

// ============================================
// COMMANDS
// ============================================

// /start
bot.onText(/\/start/, async (msg) => {
    const name = msg.from.first_name;
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Search Movie', callback_data: 'search' }],
                [
                    { text: '🎬 Hollywood', callback_data: 'cat_hollywood' },
                    { text: '🇮🇳 Bollywood', callback_data: 'cat_bollywood' }
                ],
                [
                    { text: '🌍 Dual Audio', callback_data: 'cat_dual_audio' },
                    { text: '📺 Web Series', callback_data: 'cat_web_series' }
                ],
                [{ text: '🔥 Trending', callback_data: 'trending' }, { text: '📊 Stats', callback_data: 'stats' }],
                [{ text: '❓ Help', callback_data: 'help' }]
            ]
        }
    };
    
    await bot.sendMessage(msg.chat.id,
        `🎬 *Welcome ${name}!*\n\n` +
        `📦 Movies: ${db.data.stats.totalUploads}\n` +
        `📥 Downloads: ${db.data.stats.totalDownloads}\n\n` +
        `🔍 Just type a movie name to search!\n` +
        `📂 Or browse categories below:`,
        { ...keyboard, parse_mode: 'Markdown' }
    );
});

// /admin
bot.onText(/\/admin/, async (msg) => {
    if (!CONFIG.ADMIN_IDS.includes(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, '⛔ Admin only!');
    }
    
    const stats = db.getStats();
    let text = `🔧 *Admin Panel*\n\n`;
    text += `📦 Movies: ${stats.totalMovies}\n`;
    text += `📥 Downloads: ${stats.totalDownloads}\n`;
    text += `🤖 Auto-Upload: ${CONFIG.AUTO_UPLOAD ? '✅ ON' : '❌ OFF'}\n`;
    text += `📡 Source: ${CONFIG.SOURCE_CHANNEL}\n\n`;
    text += `📂 Categories:\n`;
    for (const [cat, count] of Object.entries(stats.categories)) {
        text += `• ${cat}: ${count}\n`;
    }
    
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// /get_MOVIEID
bot.onText(/\/get_(\w+)/, async (msg, match) => {
    const movie = db.getMovie(match[1]);
    if (!movie) return bot.sendMessage(msg.chat.id, '❌ Movie not found!');
    
    const channelIds = movie.channelIds || [];
    const messageIds = movie.messageIds || [];
    
    for (let i = 0; i < channelIds.length; i++) {
        try {
            await bot.forwardMessage(msg.chat.id, channelIds[i], messageIds[i]);
            db.incrementDownloads(match[1]);
            return bot.sendMessage(msg.chat.id,
                `✅ *${movie.title}*\n📊 ${movie.quality} | ${movie.size}\n📥 Downloads: ${db.getMovie(match[1]).downloads}`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            continue;
        }
    }
    
    bot.sendMessage(msg.chat.id, '❌ Failed to send movie.');
});

// ============================================
// TEXT SEARCH
// ============================================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/') || msg.chat.type === 'channel') return;
    
    const query = msg.text.trim();
    if (query.length < 2) return;
    
    const results = db.searchMovies(query);
    if (results.length === 0) {
        return bot.sendMessage(msg.chat.id, `❌ No results for: *${query}*`, { parse_mode: 'Markdown' });
    }
    
    let reply = `🔍 *Results:* ${query}\n\n`;
    results.slice(0, 10).forEach((m, i) => {
        reply += `${i + 1}. *${m.title}* (${m.year || 'N/A'})\n   📊 ${m.quality} | ${m.size}\n   📂 ${m.category}\n   🎬 /get_${m.id}\n\n`;
    });
    
    await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
});

// ============================================
// CALLBACK QUERIES
// ============================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    
    try {
        if (data.startsWith('cat_')) {
            const category = data.replace('cat_', '');
            const movies = db.getByCategory(category, 10);
            
            if (movies.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No movies in this category yet!', show_alert: true });
                return;
            }
            
            let text = `📂 *${category.toUpperCase()}*\n\n`;
            movies.forEach((m, i) => {
                text += `${i + 1}. *${m.title}* (${m.year || 'N/A'})\n   /get_${m.id}\n\n`;
            });
            
            await bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back' }]] }
            });
        }
        else if (data === 'trending') {
            const movies = db.getTrending(10);
            let text = '🔥 *Trending*\n\n';
            movies.forEach((m, i) => {
                text += `${i + 1}. *${m.title}* - 📥${m.downloads}\n   /get_${m.id}\n\n`;
            });
            await bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back' }]] }
            });
        }
        else if (data === 'stats') {
            const stats = db.getStats();
            let text = `📊 *Stats*\n\n📦 Movies: ${stats.totalMovies}\n📥 Downloads: ${stats.totalDownloads}\n\n`;
            for (const [cat, count] of Object.entries(stats.categories)) {
                text += `• ${cat}: ${count}\n`;
            }
            await bot.editMessageText(text, {
                chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back' }]] }
            });
        }
        else if (data === 'back') {
            await bot.deleteMessage(chatId, msgId);
        }
    } catch (e) {
        console.error('Callback error:', e.message);
    }
    
    await bot.answerCallbackQuery(query.id);
});

// ============================================
// ERROR HANDLING
// ============================================
bot.on('polling_error', (error) => {
    if (error.message.includes('409')) {
        console.error('⚠️ 409 Conflict - Another instance may be running');
    } else if (error.message.includes('404')) {
        console.error('❌ Invalid bot token!');
    } else {
        console.error('Polling error:', error.message);
    }
});

// ============================================
// WEB SERVER (Required for Render)
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    const stats = db.getStats();
    res.send(`🎬 Movie Bot is Running!\n📦 Movies: ${stats.totalMovies}\n📥 Downloads: ${stats.totalDownloads}`);
});

app.listen(PORT, () => {
    console.log(`🌐 Web server listening on port ${PORT}`);
});

// ============================================
// STARTUP
// ============================================
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║     🎬 MOVIE VAULT BOT v3.0        ║');
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
