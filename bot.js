// ============================================
// TELEGRAM MOVIE BOT - WITH AUTO UPLOAD
// ============================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    // Bot
    BOT_TOKEN: process.env.BOT_TOKEN,
    
    // Admin
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
    
    // Channels
    SOURCE_CHANNEL: parseInt(process.env.SOURCE_CHANNEL) || 0,
    STORAGE_CHANNELS: (() => {
        try {
            return JSON.parse(process.env.STORAGE_CHANNELS || '{"default":0}');
        } catch (e) {
            console.error('❌ Error parsing STORAGE_CHANNELS. Using default.');
            return { "default": 0 };
        }
    })(),
    
    // TMDB
    TMDB_API_KEY: process.env.TMDB_API_KEY || '',
    
    // Settings
    AUTO_UPLOAD: process.env.AUTO_UPLOAD_ENABLED === 'true',
    MIN_MOVIE_SIZE: (parseInt(process.env.MIN_MOVIE_SIZE_MB) || 50) * 1024 * 1024,
    ADD_TO_MULTIPLE: process.env.ADD_TO_MULTIPLE_CHANNELS === 'true',
    
    // Database
    DB_FILE: path.join(__dirname, 'movies.json')
};

// ============================================
// DATABASE CLASS
// ============================================
class Database {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            console.error('⚠️ Database load error:', e.message);
        }
        return {
            movies: {},
            stats: {
                totalUploads: 0,
                totalDownloads: 0,
                lastUpdate: null
            }
        };
    }

    save() {
        try {
            this.data.stats.lastUpdate = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
            return true;
        } catch (e) {
            console.error('❌ Database save error:', e.message);
            return false;
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
            const searchText = [
                movie.title || '',
                movie.year || '',
                movie.genre || '',
                movie.language || '',
                movie.quality || '',
                movie.category || ''
            ].join(' ').toLowerCase();
            
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
        const results = Object.entries(this.data.movies)
            .map(([id, movie]) => ({ id, ...movie }))
            .sort((a, b) => b.downloads - a.downloads)
            .slice(0, limit);
        return results;
    }

    getLatest(limit = 10) {
        const results = Object.entries(this.data.movies)
            .map(([id, movie]) => ({ id, ...movie }))
            .sort((a, b) => new Date(b.addedDate) - new Date(a.addedDate))
            .slice(0, limit);
        return results;
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
            categories,
            lastUpdate: this.data.stats.lastUpdate
        };
    }
}

// ============================================
// CATEGORY DETECTION
// ============================================
const CategoryDetector = {
    HINDI_KEYWORDS: ['hindi', 'bollywood', 'hindi dubbed', 'desi', 'indian'],
    ENGLISH_KEYWORDS: ['english', 'eng', 'hollywood', 'eng sub'],
    DUAL_KEYWORDS: ['dual audio', 'dual', 'multi audio', 'hin eng', 'eng hin'],
    ANIME_KEYWORDS: ['anime', 'japanese', 'subbed', 'sub'],
    SERIES_KEYWORDS: ['web series', 'series', 'season', 'episode', 's01', 's02', 's03', 'complete season'],

    detect(text) {
        if (!text) return 'default';
        const t = text.toLowerCase();
        
        if (this.SERIES_KEYWORDS.some(k => t.includes(k))) return 'web_series';
        if (this.ANIME_KEYWORDS.some(k => t.includes(k))) return 'anime';
        if (this.DUAL_KEYWORDS.some(k => t.includes(k))) return 'dual_audio';
        if (this.HINDI_KEYWORDS.some(k => t.includes(k))) return 'bollywood';
        if (this.ENGLISH_KEYWORDS.some(k => t.includes(k))) return 'hollywood';
        if (t.includes(new Date().getFullYear().toString())) return 'new_releases';
        return 'default';
    },

    extractInfo(text) {
        const info = {
            title: '',
            year: '',
            quality: 'Unknown',
            language: 'Unknown',
            size: 'Unknown',
            genre: 'Unknown'
        };
        
        if (!text) return info;
        const t = text.toLowerCase();
        
        // Quality
        if (/2160p|4k|uhd/i.test(t)) info.quality = '4K';
        else if (/1080p|full hd|fhd|bluray/i.test(t)) info.quality = '1080p';
        else if (/720p|hd|hdrip|webrip/i.test(t)) info.quality = '720p';
        else if (/480p|sd|hq/i.test(t)) info.quality = '480p';
        
        // Year
        const yearMatch = text.match(/(19|20)\d{2}/);
        if (yearMatch) info.year = yearMatch[0];
        
        // Size
        const sizeMatch = text.match(/(\d+\.?\d*)\s*(GB|MB|gb|mb)/i);
        if (sizeMatch) info.size = sizeMatch[1] + sizeMatch[2].toUpperCase();
        
        // Language
        if (this.HINDI_KEYWORDS.some(k => t.includes(k))) info.language = 'Hindi';
        else if (this.ENGLISH_KEYWORDS.some(k => t.includes(k))) info.language = 'English';
        else if (this.DUAL_KEYWORDS.some(k => t.includes(k))) info.language = 'Dual Audio';
        
        // Genre
        const genres = ['Action', 'Comedy', 'Drama', 'Horror', 'Thriller', 'Romance', 'Sci-Fi', 'Adventure', 'Crime', 'Mystery', 'Animation'];
        for (const g of genres) {
            if (t.includes(g.toLowerCase())) {
                info.genre = g;
                break;
            }
        }
        
        // Title
        let title = text.split('\n')[0] || '';
        const emojis = ['🎬', '🎥', '📺', '🎞', '🔥', '💥', '⚡', '✅', '👉', '•', '🎯', '⭐', '🎪', '📽', '🎟', '📀', '💿'];
        emojis.forEach(e => title = title.replace(e, ''));
        if (info.year) title = title.replace(info.year, '');
        title = title.replace(/[-–—|•]/g, ' ').replace(/\s+/g, ' ').trim();
        info.title = title.substring(0, 200);
        
        return info;
    }
};

// ============================================
// INITIALIZE BOT & DATABASE
// ============================================
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
const db = new Database(CONFIG.DB_FILE);

// ============================================
// VALIDATE CONFIGURATION
// ============================================
function validateConfig() {
    const warnings = [];
    
    if (!CONFIG.BOT_TOKEN || CONFIG.BOT_TOKEN.includes('your_bot_token')) {
        console.error('❌ ERROR: BOT_TOKEN is not set! Update your .env file.');
        process.exit(1);
    }
    
    if (CONFIG.ADMIN_IDS.length === 0 || CONFIG.ADMIN_IDS[0] === 123456789) {
        warnings.push('⚠️ ADMIN_IDS not set. Admin commands will not work for you.');
    }
    
    if (!CONFIG.SOURCE_CHANNEL || CONFIG.SOURCE_CHANNEL === 0) {
        warnings.push('⚠️ SOURCE_CHANNEL not set. Auto-upload will not work.');
    }
    
    const storageChannels = Object.entries(CONFIG.STORAGE_CHANNELS).filter(([_, id]) => id !== 0);
    if (storageChannels.length === 0) {
        warnings.push('⚠️ No STORAGE_CHANNELS configured. Movies cannot be stored.');
    }
    
    return warnings;
}

// ============================================
// STARTUP LOGS
// ============================================
function logStartup() {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║     🎬 MOVIE VAULT BOT v2.0        ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
    
    const warnings = validateConfig();
    warnings.forEach(w => console.log(w));
    
    console.log(`📦 Database: ${db.data.stats.totalUploads} movies`);
    console.log(`👑 Admins: ${CONFIG.ADMIN_IDS.length}`);
    console.log(`🤖 Auto-Upload: ${CONFIG.AUTO_UPLOAD ? '✅ ON' : '❌ OFF'}`);
    console.log(`📡 Source Channel: ${CONFIG.SOURCE_CHANNEL || 'Not set'}`);
    console.log(`🗂 Storage Channels: ${Object.keys(CONFIG.STORAGE_CHANNELS).filter(k => CONFIG.STORAGE_CHANNELS[k] !== 0).length}`);
    console.log(`💾 Min File Size: ${(CONFIG.MIN_MOVIE_SIZE / (1024*1024)).toFixed(0)}MB`);
    console.log('');
    console.log('📂 Categories:');
    Object.entries(CONFIG.STORAGE_CHANNELS).forEach(([name, id]) => {
        if (id !== 0) console.log(`   • ${name}: ${id}`);
    });
    console.log('');
    console.log('✅ Bot is running and ready!');
    console.log('');
}

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
async function handleAutoUpload(msg) {
    // Check if auto-upload is enabled
    if (!CONFIG.AUTO_UPLOAD) return;
    
    // Check if from source channel
    if (msg.chat.id !== CONFIG.SOURCE_CHANNEL) return;
    
    // Check if it's a video or document
    if (!msg.video && !msg.document) return;
    
    // Check file size
    const fileSize = msg.video?.file_size || msg.document?.file_size || 0;
    if (fileSize < CONFIG.MIN_MOVIE_SIZE) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        console.log(`⚠️ File too small (${sizeMB}MB). Skipping...`);
        return;
    }
    
    console.log(`\n🎬 Auto-upload triggered! Message ID: ${msg.message_id}`);
    
    try {
        // Get caption
        let caption = msg.caption || msg.text || '';
        
        if (!caption) {
            if (msg.video?.file_name) caption = msg.video.file_name;
            else if (msg.document?.file_name) caption = msg.document.file_name;
            else caption = `Movie_${msg.message_id}`;
        }
        
        console.log(`📝 Caption: ${caption.substring(0, 150)}`);
        
        // Extract info and detect category
        const info = CategoryDetector.extractInfo(caption);
        const category = CategoryDetector.detect(caption);
        
        console.log(`📊 Detected: "${info.title}" → ${category}`);
        
        // Get storage channel
        const storageId = CONFIG.STORAGE_CHANNELS[category] || CONFIG.STORAGE_CHANNELS['default'];
        
        if (!storageId || storageId === 0) {
            console.log(`❌ No storage channel for category: ${category}`);
            await notifyAdmin(`❌ Auto-upload failed: No storage channel for category "${category}"`);
            return;
        }
        
        // Forward to primary storage channel
        const sent = await bot.forwardMessage(storageId, CONFIG.SOURCE_CHANNEL, msg.message_id);
        console.log(`✅ Forwarded to ${category} channel (ID: ${storageId})`);
        
        // Build movie data
        const movieData = {
            title: info.title || `Movie_${msg.message_id}`,
            year: info.year || 'Unknown',
            quality: info.quality,
            language: info.language,
            size: info.size || `${(fileSize / (1024 * 1024)).toFixed(0)}MB`,
            genre: info.genre,
            category: category,
            channelIds: [storageId],
            messageIds: [sent.message_id],
            plot: caption.substring(0, 500),
            keywords: caption,
            sourceMessageId: msg.message_id,
            fileSizeBytes: fileSize
        };
        
        // Add to multiple channels if enabled
        if (CONFIG.ADD_TO_MULTIPLE) {
            // Also add to new_releases
            if (category !== 'new_releases' && CONFIG.STORAGE_CHANNELS['new_releases']) {
                try {
                    const newMsg = await bot.forwardMessage(
                        CONFIG.STORAGE_CHANNELS['new_releases'],
                        CONFIG.SOURCE_CHANNEL,
                        msg.message_id
                    );
                    movieData.channelIds.push(CONFIG.STORAGE_CHANNELS['new_releases']);
                    movieData.messageIds.push(newMsg.message_id);
                    console.log('✅ Also added to new_releases channel');
                } catch (e) {
                    console.log('⚠️ Failed to add to new_releases:', e.message);
                }
            }
            
            // Also add to default for backup
            if (category !== 'default' && CONFIG.STORAGE_CHANNELS['default']) {
                try {
                    const defMsg = await bot.forwardMessage(
                        CONFIG.STORAGE_CHANNELS['default'],
                        CONFIG.SOURCE_CHANNEL,
                        msg.message_id
                    );
                    movieData.channelIds.push(CONFIG.STORAGE_CHANNELS['default']);
                    movieData.messageIds.push(defMsg.message_id);
                    console.log('✅ Also added to default channel (backup)');
                } catch (e) {
                    console.log('⚠️ Failed to add to default:', e.message);
                }
            }
        }
        
        // Save to database
        const movieId = db.addMovie(movieData);
        
        // Notify admin
        const notification = [
            '✅ *Movie Auto-Uploaded!*',
            '',
            `🎬 *Title:* ${movieData.title}`,
            `📅 *Year:* ${movieData.year}`,
            `📊 *Quality:* ${movieData.quality}`,
            `🌐 *Language:* ${movieData.language}`,
            `💾 *Size:* ${movieData.size}`,
            `🎭 *Genre:* ${movieData.genre}`,
            `📂 *Category:* ${category}`,
            `🆔 *ID:* ${movieId}`,
            `📁 *Storage Locations:* ${movieData.channelIds.length}`,
            '',
            `📦 *Total Movies:* ${db.data.stats.totalUploads}`,
            `📥 *Total Downloads:* ${db.data.stats.totalDownloads}`
        ].join('\n');
        
        await notifyAdmin(notification);
        
        console.log(`🎉 SUCCESS: "${movieData.title}" added as ${movieId}`);
        console.log('');
        
    } catch (error) {
        console.error('❌ Auto-upload error:', error.message);
        await notifyAdmin(`❌ Auto-upload failed: ${error.message}\n\nMessage ID: ${msg.message_id}`);
    }
}

// ============================================
// COMMAND HANDLERS
// ============================================

// /start command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userName = msg.from.first_name;
    
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Search Movie', callback_data: 'menu_search' }],
                [
                    { text: '🎬 Hollywood', callback_data: 'cat_hollywood' },
                    { text: '🇮🇳 Bollywood', callback_data: 'cat_bollywood' }
                ],
                [
                    { text: '🌍 Dual Audio', callback_data: 'cat_dual_audio' },
                    { text: '📺 Web Series', callback_data: 'cat_web_series' }
                ],
                [
                    { text: '🎭 Anime', callback_data: 'cat_anime' },
                    { text: '🆕 Latest', callback_data: 'cat_new_releases' }
                ],
                [
                    { text: '🔥 Trending', callback_data: 'menu_trending' },
                    { text: '📊 Stats', callback_data: 'menu_stats' }
                ],
                [{ text: '❓ Help', callback_data: 'menu_help' }]
            ]
        }
    };
    
    const welcomeMsg = [
        `🎬 *Welcome to MovieVault Bot, ${userName}!*`,
        '',
        '⚡️ *Features:*',
        '• 🔍 Search movies by name',
        '• 📂 Browse by category',
        '• 🤖 Auto-updated daily',
        '• ⚡ Instant delivery',
        '',
        '📥 *How to Download:*',
        '1️⃣ Type a movie name to search',
        '2️⃣ Click on the result',
        '3️⃣ Get movie instantly!',
        '',
        '🔍 *Try searching:*',
        '• Inception',
        '• Avengers',
        '• Breaking Bad',
        '',
        '👇 Use buttons below or just type a movie name!'
    ].join('\n');
    
    await bot.sendMessage(chatId, welcomeMsg, { ...keyboard, parse_mode: 'Markdown' });
});

// /admin command
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!CONFIG.ADMIN_IDS.includes(msg.from.id)) {
        return bot.sendMessage(chatId, '⛔ *Admin only!*', { parse_mode: 'Markdown' });
    }
    
    const stats = db.getStats();
    
    const adminMsg = [
        '🔧 *Admin Control Panel*',
        '',
        `👑 Welcome, ${msg.from.first_name}!`,
        '',
        '📊 *Statistics:*',
        `• Movies: ${stats.totalMovies}`,
        `• Downloads: ${stats.totalDownloads}`,
        `• Categories: ${Object.keys(stats.categories).length}`,
        '',
        '📂 *Movies by Category:*',
        ...Object.entries(stats.categories).map(([cat, count]) => `• ${cat}: ${count}`),
        '',
        `🤖 Auto-Upload: ${CONFIG.AUTO_UPLOAD ? '✅ ON' : '❌ OFF'}`,
        `📡 Source: ${CONFIG.SOURCE_CHANNEL || 'Not set'}`,
        `💾 Min Size: ${(CONFIG.MIN_MOVIE_SIZE / (1024 * 1024)).toFixed(0)}MB`,
        '',
        `📅 Last Update: ${stats.lastUpdate ? new Date(stats.lastUpdate).toLocaleString() : 'Never'}`
    ].join('\n');
    
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📋 Latest Movies', callback_data: 'admin_latest' },
                    { text: '🔥 Trending', callback_data: 'admin_trending' }
                ],
                [
                    { text: '📊 Full Stats', callback_data: 'admin_fullstats' },
                    { text: '🔄 Refresh', callback_data: 'admin_refresh' }
                ],
                [{ text: '❌ Close Panel', callback_data: 'admin_close' }]
            ]
        }
    };
    
    await bot.sendMessage(chatId, adminMsg, { ...keyboard, parse_mode: 'Markdown' });
});

// /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMsg = [
        '📚 *Help Guide*',
        '',
        '🔍 *Search Movies:*',
        'Just type a movie name in the chat',
        '',
        '📂 *Browse Categories:*',
        '• Hollywood - English movies',
        '• Bollywood - Hindi movies',
        '• Dual Audio - Multi-language',
        '• Web Series - TV shows',
        '• Anime - Japanese animation',
        '• Latest - New releases',
        '',
        '📥 *Get Movie:*',
        'Type: /get_MOV1000',
        '(Replace MOV1000 with actual ID)',
        '',
        '📝 *Commands:*',
        '/start - Main menu',
        '/help - This help',
        '/admin - Admin panel',
        '',
        '🆘 *Need Help?*',
        'Contact admin for support'
    ].join('\n');
    
    await bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
});

// /get_MOVIEID command
bot.onText(/\/get_(\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const movieId = match[1];
    
    const movie = db.getMovie(movieId);
    
    if (!movie) {
        return bot.sendMessage(chatId, '❌ *Movie not found!*\n\nTry searching with the movie name instead.', { parse_mode: 'Markdown' });
    }
    
    const channelIds = movie.channelIds || [];
    const messageIds = movie.messageIds || [];
    
    if (channelIds.length === 0) {
        return bot.sendMessage(chatId, '❌ *Movie file not available!*', { parse_mode: 'Markdown' });
    }
    
    // Try each storage location
    for (let i = 0; i < channelIds.length; i++) {
        try {
            await bot.forwardMessage(chatId, channelIds[i], messageIds[i]);
            
            // Update download count
            db.incrementDownloads(movieId);
            const updated = db.getMovie(movieId);
            
            const successMsg = [
                '✅ *Movie Delivered!*',
                '',
                `🎬 *${movie.title}*`,
                `📅 ${movie.year || 'N/A'} | 📊 ${movie.quality || 'N/A'}`,
                `🌐 ${movie.language || 'N/A'} | 💾 ${movie.size || 'N/A'}`,
                `📂 ${movie.category || 'N/A'}`,
                '',
                `📥 Total Downloads: ${updated.downloads}`,
                '',
                '🙏 Enjoy your movie!'
            ].join('\n');
            
            await bot.sendMessage(chatId, successMsg, { parse_mode: 'Markdown' });
            return;
            
        } catch (e) {
            console.log(`⚠️ Failed to forward from channel ${channelIds[i]}: ${e.message}`);
            continue;
        }
    }
    
    await bot.sendMessage(chatId, '❌ *Failed to send movie!*\n\nPlease try again later or contact admin.', { parse_mode: 'Markdown' });
});

// /stats command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const stats = db.getStats();
    
    const statsMsg = [
        '📊 *Bot Statistics*',
        '',
        `📦 Total Movies: *${stats.totalMovies}*`,
        `📥 Total Downloads: *${stats.totalDownloads}*`,
        '',
        '📂 *By Category:*',
        ...Object.entries(stats.categories).map(([cat, count]) => `• ${cat}: ${count}`),
        '',
        `📅 Last Updated: ${stats.lastUpdate ? new Date(stats.lastUpdate).toLocaleString() : 'Never'}`
    ].join('\n');
    
    await bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
});

// ============================================
// TEXT SEARCH HANDLER
// ============================================
bot.on('message', async (msg) => {
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;
    
    // Skip channel posts (handled by auto-upload)
    if (msg.chat.type === 'channel') return;
    
    // Skip non-text messages
    if (!msg.text) return;
    
    const chatId = msg.chat.id;
    const query = msg.text.trim();
    
    // Skip very short queries
    if (query.length < 2) return;
    
    const results = db.searchMovies(query);
    
    if (results.length === 0) {
        return bot.sendMessage(
            chatId,
            `❌ No results for: *${query}*\n\nTry different keywords or browse categories with /start`,
            { parse_mode: 'Markdown' }
        );
    }
    
    let reply = `🔍 *Search Results:* ${query}\n\n`;
    
    results.slice(0, 10).forEach((movie, i) => {
        reply += `${i + 1}. *${movie.title || 'Unknown'}*`;
        if (movie.year && movie.year !== 'Unknown') reply += ` (${movie.year})`;
        reply += `\n   📊 ${movie.quality || 'N/A'} | 💾 ${movie.size || 'N/A'}`;
        reply += `\n   📂 ${movie.category || 'N/A'} | 🌐 ${movie.language || 'N/A'}`;
        reply += `\n   🎬 /get_${movie.id}\n\n`;
    });
    
    if (results.length > 10) {
        reply += `...and ${results.length - 10} more results. Refine your search for better results.`;
    }
    
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
});

// ============================================
// CALLBACK QUERY HANDLER
// ============================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const messageId = query.message.message_id;
    
    try {
        // Category browsing
        if (data.startsWith('cat_')) {
            const category = data.replace('cat_', '');
            const movies = db.getByCategory(category, 10);
            
            if (movies.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No movies in this category yet! 🎬', show_alert: true });
                return;
            }
            
            const categoryNames = {
                'hollywood': '🎬 Hollywood Movies',
                'bollywood': '🇮🇳 Bollywood Movies',
                'dual_audio': '🌍 Dual Audio Movies',
                'web_series': '📺 Web Series',
                'anime': '🎭 Anime',
                'new_releases': '🆕 New Releases',
                'default': '📦 General'
            };
            
            let text = `${categoryNames[category] || category}\n\n`;
            
            movies.forEach((movie, i) => {
                text += `${i + 1}. *${movie.title}*`;
                if (movie.year && movie.year !== 'Unknown') text += ` (${movie.year})`;
                text += `\n   📊 ${movie.quality} | 💾 ${movie.size}`;
                text += `\n   🎬 /get_${movie.id}\n\n`;
            });
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]]
                }
            });
        }
        
        // Trending
        else if (data === 'menu_trending') {
            const movies = db.getTrending(10);
            
            if (movies.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: 'No movies yet!', show_alert: true });
                return;
            }
            
            let text = '🔥 *Trending Movies*\n\n';
            movies.forEach((movie, i) => {
                text += `${i + 1}. *${movie.title}* (${movie.year || 'N/A'})`;
                text += `\n   📥 ${movie.downloads} downloads`;
                text += `\n   🎬 /get_${movie.id}\n\n`;
            });
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]]
                }
            });
        }
        
        // Stats
        else if (data === 'menu_stats') {
            const stats = db.getStats();
            
            let text = '📊 *Bot Statistics*\n\n';
            text += `📦 Total Movies: *${stats.totalMovies}*\n`;
            text += `📥 Total Downloads: *${stats.totalDownloads}*\n\n`;
            text += '📂 *By Category:*\n';
            for (const [cat, count] of Object.entries(stats.categories)) {
                text += `• ${cat}: ${count}\n`;
            }
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]]
                }
            });
        }
        
        // Help
        else if (data === 'menu_help') {
            const helpMsg = [
                '📚 *Help Guide*',
                '',
                '🔍 *Search:* Type movie name',
                '📂 *Browse:* Use category buttons',
                '📥 *Download:* /get_MOV1000',
                '',
                '📝 *Commands:*',
                '/start - Main menu',
                '/help - Help',
                '/stats - Statistics',
                '/admin - Admin panel'
            ].join('\n');
            
            await bot.editMessageText(helpMsg, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]]
                }
            });
        }
        
        // Back to menu
        else if (data === 'menu_back') {
            await bot.deleteMessage(chatId, messageId);
            // Trigger start again
            const fakeMsg = { chat: { id: chatId }, from: query.from };
            bot.emit('text', { ...fakeMsg, text: '/start' });
        }
        
        // Admin callbacks
        else if (data === 'admin_latest') {
            const movies = db.getLatest(10);
            let text = '📋 *Latest Uploads*\n\n';
            
            if (movies.length === 0) {
                text += 'No movies yet!';
            } else {
                movies.forEach((m, i) => {
                    text += `${i + 1}. *${m.title}* (${m.year || 'N/A'})\n   📂 ${m.category} | 🆔 ${m.id}\n\n`;
                });
            }
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refresh' }]]
                }
            });
        }
        
        else if (data === 'admin_trending') {
            const movies = db.getTrending(10);
            let text = '🔥 *Trending*\n\n';
            movies.forEach((m, i) => {
                text += `${i + 1}. *${m.title}* - 📥${m.downloads}\n`;
            });
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refresh' }]]
                }
            });
        }
        
        else if (data === 'admin_fullstats') {
            const stats = db.getStats();
            let text = '📊 *Full Statistics*\n\n';
            text += `📦 Movies: ${stats.totalMovies}\n`;
            text += `📥 Downloads: ${stats.totalDownloads}\n\n`;
            text += '*Categories:*\n';
            for (const [cat, count] of Object.entries(stats.categories)) {
                text += `• ${cat}: ${count}\n`;
            }
            
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back', callback_data: 'admin_refresh' }]]
                }
            });
        }
        
        else if (data === 'admin_refresh') {
            await bot.deleteMessage(chatId, messageId);
            const fakeMsg = { chat: { id: chatId }, from: query.from };
            bot.emit('text', { ...fakeMsg, text: '/admin' });
        }
        
        else if (data === 'admin_close') {
            await bot.deleteMessage(chatId, messageId);
        }
        
        else if (data === 'menu_search') {
            await bot.editMessageText(
                '🔍 *Search Movies*\n\nJust type a movie name in the chat to search!\n\nExample: Inception, Avengers, Breaking Bad',
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]]
                    }
                }
            );
        }
        
    } catch (e) {
        console.error('Callback error:', e.message);
    }
    
    await bot.answerCallbackQuery(query.id);
});

// ============================================
// CHANNEL POST HANDLER (Auto-Upload)
// ============================================
bot.on('channel_post', async (msg) => {
    await handleAutoUpload(msg);
});

// ============================================
// ERROR HANDLERS
// ============================================
bot.on('polling_error', (error) => {
    if (error.message.includes('404')) {
        console.error('❌ BOT TOKEN IS INVALID! Check your .env file.');
        console.error('Get a new token from @BotFather');
    } else if (error.message.includes('401')) {
        console.error('❌ BOT TOKEN IS UNAUTHORIZED! Token may have been revoked.');
        console.error('Get a new token from @BotFather using /mybots → API Token → Revoke');
    } else {
        console.error('⚠️ Polling error:', error.message);
    }
});

bot.on('error', (error) => {
    console.error('❌ Bot error:', error.message);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    db.save();
    console.log('✅ Database saved. Goodbye!');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down...');
    db.save();
    console.log('✅ Database saved. Goodbye!');
    process.exit(0);
});

// ============================================
// START BOT
// ============================================
logStartup();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// This is the health check page
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Web server is listening on port ${PORT}`);
});