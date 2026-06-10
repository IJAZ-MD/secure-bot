require("dotenv").config();
const dns = require("node:dns");
/*
try {
    dns.setDefaultResultOrder("ipv4first");
} catch (e) {
    console.warn("Could not set DNS result order to IPv4 first:", e.message);
}
*/

// Tiny keep-alive (no Express — saves ~30–50MB RAM)
if (process.env.DISABLE_WEB !== "1") {
    const http = require("http");
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Bot is running");
    }).listen(PORT, () => console.log(`Web server on port ${PORT}`));
}

const {
    Client,
    GatewayIntentBits,
    Partials,
    Options,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require("discord.js");

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    NoSubscriberBehavior,
    AudioPlayerStatus,
    entersState,
    VoiceConnectionStatus,
    StreamType
} = require("@discordjs/voice");
const path = require("path");
const { spawn, execSync } = require("child_process");
const fs = require('fs');


const YTDLP_BIN = path.join(__dirname, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
let ytDlpPathPromise = null;
let ytDlpWrapCache = null;
let ffmpegPathCache = null;

function getFfmpegPath() {
    if (!ffmpegPathCache) {
        if (process.env.FFMPEG_PATH) {
            ffmpegPathCache = process.env.FFMPEG_PATH;
        } else {
            ffmpegPathCache = require("ffmpeg-static");
            process.env.FFMPEG_PATH = ffmpegPathCache;
        }
    }
    return ffmpegPathCache;
}

async function ensureYtDlpPath() {
    if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
    if (!ytDlpPathPromise) {
        ytDlpPathPromise = (async () => {
            if (process.platform !== "win32") {
                try {
                    const systemBin = execSync("which yt-dlp", { encoding: "utf8" }).trim();
                    if (systemBin) return systemBin;
                } catch { /* use bundled download */ }
            }
            const fsLocal = require("fs");
            if (!fsLocal.existsSync(YTDLP_BIN)) {
                console.log("📥 Downloading yt-dlp (first run only)...");
                fsLocal.mkdirSync(path.dirname(YTDLP_BIN), { recursive: true });
                const YTDlpWrap = require("yt-dlp-wrap").default;
                await YTDlpWrap.downloadFromGithub(YTDLP_BIN, undefined, process.platform);
                console.log("✅ yt-dlp ready");
            }
            return YTDLP_BIN;
        })();
    }
    return ytDlpPathPromise;
}

async function getYtDlpWrap() {
    const bin = await ensureYtDlpPath();
    if (!ytDlpWrapCache) {
        const YTDlpWrap = require("yt-dlp-wrap").default;
        ytDlpWrapCache = new YTDlpWrap(bin);
    }
    return ytDlpWrapCache;
}

async function searchYoutube(query, limit = 10) {
    const wrap = await getYtDlpWrap();
    const out = await wrap.execPromise([
        `ytsearch${limit}:${query}`,
        "--flat-playlist",
        "--print", "%(id)s@@%(title)s",
        "--no-warnings",
        "--quiet"
    ]);
    return out.trim().split("\n").filter(Boolean).map((line) => {
        const sep = line.indexOf("@@");
        if (sep < 1) return null;
        const id = line.slice(0, sep);
        const title = line.slice(sep + 2);
        return {
            id,
            title,
            url: `https://www.youtube.com/watch?v=${id}`
        };
    }).filter(Boolean);
}

function stopVoicePlayback(connection) {
    if (connection._currentPlayer) {
        connection._currentPlayer.stop(true);
        connection._currentPlayer = null;
    }
    if (connection._ytdlpProcess) {
        connection._ytdlpProcess.kill();
        connection._ytdlpProcess = null;
    }
    if (connection._ffmpegProcess) {
        connection._ffmpegProcess.kill();
        connection._ffmpegProcess = null;
    }
}

function ensureBotInVoiceChannel(guildId, channel) {
    let connection = getVoiceConnection(guildId);
    const targetId = channel.id;

    if (connection) {
        const currentId = connection.joinConfig.channelId;
        if (currentId !== targetId) {
            console.log(`📡 Moving bot to ${channel.name} for playback`);
            stopVoicePlayback(connection);
            connection.intentionalDisconnect = true;
            connection.destroy();
            connection = connectToVoice(channel);
        }
    } else {
        connection = connectToVoice(channel);
    }

    return connection;
}

async function streamYoutubeToConnection(connection, videoUrl) {
    const ytDlpWrap = await getYtDlpWrap();
    const ffmpegPath = getFfmpegPath();

    console.log("🎶 Resolving direct audio URL...");
    const audioUrl = (await ytDlpWrap.execPromise([
        videoUrl,
        "-f", "bestaudio[ext=webm]/bestaudio/best",
        "-g",
        "--no-playlist",
        "--no-warnings"
    ])).trim().split("\n")[0];

    if (!audioUrl.startsWith("http")) {
        throw new Error("Could not resolve YouTube audio stream URL");
    }

    const ffmpeg = spawn(ffmpegPath, [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", audioUrl,
        "-vn",
        "-loglevel", "error",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    connection._ffmpegProcess = ffmpeg;
    connection._ytdlpProcess = null;
    connection._isMusicPlay = true;

    ffmpeg.stderr.on("data", (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Play FFmpeg] ${msg}`);
    });
    ffmpeg.on("error", (err) => console.error("Play FFmpeg error:", err));
    ffmpeg.on("close", (code) => {
        if (code !== 0 && code !== null) console.error(`Play FFmpeg exited with code ${code}`);
    });

    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    connection._currentPlayer = player;
    connection._isLagLoop = false;

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw
    });

    player.on("stateChange", (oldState, newState) => {
        console.log(`🎵 Play AudioPlayer state: ${oldState.status} -> ${newState.status}`);
    });
    player.on("error", (error) => console.error("🎵 Play Audio Player Error:", error));
    player.once(AudioPlayerStatus.Idle, () => {
        if (!connection._isMusicPlay) return;
        console.log("🎵 Play finished.");
        connection._isMusicPlay = false;
        stopVoicePlayback(connection);
    });

    connection.subscribe(player);
    player.play(resource);
    return player;
}

function parsePlayChoice(raw) {
    if (!raw) return { url: null, title: null };
    if (raw.startsWith("http")) return { url: raw, title: null };
    const pipe = raw.indexOf("|");
    if (pipe > 0) {
        const id = raw.slice(0, pipe).trim();
        const title = raw.slice(pipe + 1).trim();
        if (/^[\w-]{11}$/.test(id)) {
            return {
                url: `https://www.youtube.com/watch?v=${id}`,
                title: title || null
            };
        }
    }
    return { url: null, title: null, query: raw };
}

// ================= CONFIG =================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const autoRoleName = "Member";
const antiSpamLimit = 5;
const antiSpamTime = 5000;
const STAY_VC_ID = process.env.STAY_VC_ID;
const OWNER_ID = process.env.OWNER_ID; // The bot will DM this user for drag prompts
const UP_LOOP_GENERAL_VC_ID = process.env.UP_LOOP_GENERAL_VC_ID || "1462766758585700495";
const UP_LOOP_MUSIC_VC_ID = process.env.UP_LOOP_MUSIC_VC_ID || "1340041447541571691";
const UP_LOOP_MS = Number(process.env.UP_LOOP_MS) || 1200;

const upLoops = new Map();

function isBotOwner(user, guild) {
    return (OWNER_ID && user.id === OWNER_ID) || user.id === guild.ownerId;
}

function findUpLoopChannels(guild) {
    const general = guild.channels.cache.get(UP_LOOP_GENERAL_VC_ID)
        || guild.channels.cache.find((c) =>
            c.isVoiceBased() && normalizeChannelName(c.name).includes("general"));
    const music = guild.channels.cache.get(UP_LOOP_MUSIC_VC_ID)
        || guild.channels.cache.find((c) =>
            c.isVoiceBased() && normalizeChannelName(c.name).includes("music"));
    return { general, music };
}

function stopUpLoop(guildId) {
    const loop = upLoops.get(guildId);
    if (!loop) return false;
    loop.active = false;
    clearInterval(loop.interval);
    upLoops.delete(guildId);
    return true;
}

function startUpLoop(guild, targetMember, channels, moderator) {
    stopUpLoop(guild.id);

    let index = 0;
    let busy = false;
    let paused = false;

    const tick = async () => {
        const loop = upLoops.get(guild.id);
        if (!loop?.active) return;
        if (busy) return;
        busy = true;

        try {
            const member = await guild.members.fetch(targetMember.id).catch(() => null);
            if (!member) {
                stopUpLoop(guild.id);
                return;
            }

            if (!member.voice.channel) {
                if (!paused) {
                    console.log(`⏸️ UP loop paused for ${member.user.tag} — not in voice`);
                    paused = true;
                }
                return;
            }

            if (paused) {
                console.log(`▶️ UP loop resumed for ${member.user.tag} — joined voice`);
                paused = false;
            }

            const channel = channels[index % channels.length];
            index += 1;
            if (member.voice.channelId !== channel.id) {
                await member.voice.setChannel(channel);
            }
        } catch (err) {
            console.error("UP loop drag error:", err);
        } finally {
            busy = false;
        }
    };

    upLoops.set(guild.id, {
        active: true,
        targetId: targetMember.id,
        moderatorId: moderator.id,
        interval: setInterval(() => { tick().catch(() => {}); }, UP_LOOP_MS)
    });

    // Log the start
    logModerationAction(guild, "Voice Drag Started", moderator, targetMember);

    tick().catch(() => {});
}

async function logModerationAction(guild, action, moderator, target) {
    const logChannelId = process.env.MOD_LOG_CHANNEL_ID;
    if (!logChannelId) return;

    const channel = await guild.channels.fetch(logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
        .setTitle(action)
        .setColor(action.includes("Started") ? 0x27ae60 : 0xe74c3c)
        .addFields(
            { name: "👮 Moderator", value: `${moderator}`, inline: true },
            { name: "👤 Target", value: `${target}`, inline: true },
            { name: "⏰ Timestamp", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
        )
        .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => {});
}

// ================= CLIENT =================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel],
    // Lower RAM: don't cache every message/member forever
    makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        PresenceManager: 0,
        ReactionManager: 0,
        GuildEmojiManager: 0,
        StageInstanceManager: 0,
        VoiceStateManager: 50,
        GuildMemberManager: 100,
        UserManager: 100
    })
});

// ================= SLASH COMMANDS =================

const commands = [
    new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Check if bot is alive"),

    new SlashCommandBuilder()
        .setName("join")
        .setDescription("Join your voice channel"),

    new SlashCommandBuilder()
        .setName("leave")
        .setDescription("Leave voice channel"),

    new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play a song from YouTube")
        .addStringOption(option =>
            option.setName("song")
                .setDescription("Search query or YouTube URL")
                .setRequired(true)
                .setAutocomplete(true)),

    new SlashCommandBuilder()
        .setName("lag")
        .setDescription("Plays the lag audio on loop in your voice channel"),

    new SlashCommandBuilder()
        .setName("dump")
        .setDescription("Plays the dump audio on loop in your voice channel (Owner only)"),

    new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop any currently playing audio and disconnect"),

    new SlashCommandBuilder()
        .setName("testplay")
        .setDescription("Plays a high-quality sample mp3 audio from the web to test sound"),

    new SlashCommandBuilder()
        .setName("up")
        .setDescription("Loop-drag a user between General VC and Music (Owner only)")
        .addUserOption((option) =>
            option.setName("user")
                .setDescription("Member to move")
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName("down")
        .setDescription("Stop the /up loop-drag")
        .addUserOption((option) =>
            option.setName("user")
                .setDescription("Member to stop moving")
                .setRequired(true)),

].map(cmd => cmd.toJSON());

if (CLIENT_ID && GUILD_ID) {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    (async () => {
        try {
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
                { body: commands }
            );
            console.log("✅ Slash commands registered");
        } catch (err) {
            console.error("Command registration error:", err);
        }
    })();
}

// ================= READY =================

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag} (low-memory mode)`);

    client.user.setPresence({
        activities: [{ name: "4CZ Secure 24/7 🔥" }],
        status: "online"
    });

    // 24/7 Join logic on startup
    if (STAY_VC_ID && GUILD_ID) {
        setTimeout(async () => {
            try {
                const guild = await client.guilds.fetch(GUILD_ID);
                const channel = await guild.channels.fetch(STAY_VC_ID);
                if (channel && channel.isVoiceBased()) {
                    connectToVoice(channel);
                    console.log(`📡 24/7 Mode: Joined ${channel.name}`);
                }
            } catch (err) {
                console.error("Failed to join 24/7 VC on startup:", err);
            }
        }, 5000);
    }
});

// Helper to download files locally (so FFmpeg can reliably loop them)
function downloadFile(url, dest) {
    const fs = require('fs');
    const https = require('https');
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) return resolve();
        
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                return reject(new Error(`Failed to download: ${response.statusCode}`));
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {}); // Delete the file on error
            reject(err);
        });
    });
}

// Helper function for robust voice connection
function connectToVoice(channel) {
    console.log(`📡 Attempting to join voice channel: ${channel.name} (${channel.id})`);
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    connection.on('stateChange', (oldState, newState) => {
        console.log(`📡 VoiceConnection state: ${oldState.status} -> ${newState.status}`);
    });

    connection.on('error', (err) => {
        console.error("📡 VoiceConnection error:", err);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        if (connection.intentionalDisconnect) return;
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5000),
            ]);
            // Seems to be reconnecting
        } catch (e) {
            // Real disconnect
            if (connection.intentionalDisconnect) return;
            console.log("Reconnecting to voice...");
            setTimeout(() => {
                if (!connection.intentionalDisconnect) {
                    connectToVoice(channel);
                }
            }, 5000);
        }
    });

    return connection;
}

function normalizeChannelName(name) {
    if (!name) return "";
    return name
        .replace(/[\uD835][\uDC00-\uDFFF]/g, (char) => {
            const code = char.codePointAt(0);
            if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(code - 0x1D400 + 65);
            if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(code - 0x1D41A + 97);
            if (code >= 0x1D434 && code <= 0x1D44D) return String.fromCharCode(code - 0x1D434 + 65);
            if (code >= 0x1D44E && code <= 0x1D467) return String.fromCharCode(code - 0x1D44E + 97);
            if (code >= 0x1D468 && code <= 0x1D481) return String.fromCharCode(code - 0x1D468 + 65);
            if (code >= 0x1D482 && code <= 0x1D49B) return String.fromCharCode(code - 0x1D482 + 97);
            if (code >= 0x1D49C && code <= 0x1D4B5) return String.fromCharCode(code - 0x1D49C + 65);
            if (code >= 0x1D4B6 && code <= 0x1D4CF) return String.fromCharCode(code - 0x1D4B6 + 97);
            if (code >= 0x1D4D0 && code <= 0x1D4E9) return String.fromCharCode(code - 0x1D4D0 + 65);
            if (code >= 0x1D4EA && code <= 0x1D503) return String.fromCharCode(code - 0x1D4EA + 97);
            if (code >= 0x1D504 && code <= 0x1D51D) return String.fromCharCode(code - 0x1D504 + 65);
            if (code >= 0x1D51E && code <= 0x1D537) return String.fromCharCode(code - 0x1D51E + 97);
            if (code >= 0x1D538 && code <= 0x1D551) return String.fromCharCode(code - 0x1D538 + 65);
            if (code >= 0x1D552 && code <= 0x1D56B) return String.fromCharCode(code - 0x1D552 + 97);
            if (code >= 0x1D5A0 && code <= 0x1D5B9) return String.fromCharCode(code - 0x1D5A0 + 65);
            if (code >= 0x1D5BA && code <= 0x1D5D3) return String.fromCharCode(code - 0x1D5BA + 97);
            if (code >= 0x1D5D4 && code <= 0x1D5ED) return String.fromCharCode(code - 0x1D5D4 + 65);
            if (code >= 0x1D5EE && code <= 0x1D607) return String.fromCharCode(code - 0x1D5EE + 97);
            if (code >= 0x1D670 && code <= 0x1D689) return String.fromCharCode(code - 0x1D670 + 65);
            if (code >= 0x1D68A && code <= 0x1D6A3) return String.fromCharCode(code - 0x1D68A + 97);
            return char;
        })
        .toLowerCase()
        .replace(/ʀ/g, 'r')
        .replace(/ɪ/g, 'i')
        .replace(/ᴠ/g, 'v')
        .replace(/\s+/g, '') // Remove all spaces
        .trim();
}

// ================= WELCOME SYSTEM =================

client.on("guildMemberAdd", async (member) => {
    try {
        const role = member.guild.roles.cache.find(r => r.name === autoRoleName);
        if (role) await member.roles.add(role);

        const channel = member.guild.systemChannel;
        if (channel) {
            channel.send(`🌸 Welcome ${member}!`);
        }

        await member.send("💕 Welcome to the server! Please read the rules.");
    } catch (err) {
        console.log("Welcome error:", err);
    }
});

// ================= VOICE STATE UPDATE (DRAG SYSTEM) =================

client.on("voiceStateUpdate", async (oldState, newState) => {
    // The UP loop now handles pause/resume internally via the tick function.
    // No need to stop the loop when the user leaves voice.

    // Check if the bot itself was disconnected from a voice channel
    if (newState.member.id === client.user.id && !newState.channelId) {
        console.log("🤖 Bot was disconnected from voice channel.");
        const connection = getVoiceConnection(newState.guild.id);
        if (connection) {
            connection.intentionalDisconnect = true;
            if (connection._currentPlayer) {
                connection._currentPlayer.stop(true);
            }
            if (connection._ffmpegProcess) {
                connection._ffmpegProcess.kill();
                connection._ffmpegProcess = null;
            }
            connection.destroy();
        }
        return;
    }

    // Only trigger if a non-bot member joins a voice channel
    if (!newState.channelId) return;
    if (newState.member.user.bot) return;
    if (oldState.channelId === newState.channelId) return;

    const normalizedName = normalizeChannelName(newState.channel.name);

    // Check if they joined the specific drag channel (by ID or name)
    if (newState.channelId === "1500479653884727366" || normalizedName.includes("drag")) {
        console.log(`👤 [VOICE-DRAG] ${newState.member.user.tag} joined "${newState.channel.name}" channel.`);
        
        // Reset intentionalDisconnect for this guild if it was set
        const oldConn = getVoiceConnection(newState.guild.id);
        if (oldConn) oldConn.intentionalDisconnect = false;

        const guild = newState.guild;
        
        // Fetch channels to ensure cache is fresh
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        
        // Find 🔒4C_Pʀɪᴠ𝒂𝒕𝒆 channel (by ID first, then robust name matching)
        const privateChannel = channels.get("1392472428747165817") || channels.find(c => 
            c.isVoiceBased() && (
                normalizeChannelName(c.name).includes("private") || 
                c.name.includes("🔒") || 
                c.name.includes("Pʀɪᴠ𝒂𝒕𝒆")
            )
        );

        // Find ・𝑺𝒆𝒄𝒖𝒓𝒆𝒅      //// channel (by ID first, then robust name matching)
        const securedChannel = channels.get("1475023162642272442") || channels.find(c => 
            c.isVoiceBased() && (
                normalizeChannelName(c.name).includes("secured") ||
                c.name.includes("𝑺𝒆𝒄𝒖𝒓𝒆𝒅")
            )
        );

        if (!privateChannel) {
            console.error("❌ [VOICE-DRAG] Could not find 🔒4C_Pʀɪᴠ𝒂𝒕𝒆 voice channel.");
            return;
        }

        try {
            // Prevent old connection from triggering auto-reconnect loops
            const existingConn = getVoiceConnection(guild.id);
            if (existingConn?._isMusicPlay) {
                console.log("⏭️ Skipping drag tone — music is playing");
                return;
            }
            if (existingConn) {
                existingConn.intentionalDisconnect = true;
                existingConn.destroy();
            }

            console.log(`🤖 Akaza is joining 🔒4C_Pʀɪᴠ𝒂𝒕𝒆: ${privateChannel.name}`);
            const connection = joinVoiceChannel({
                channelId: privateChannel.id,
                guildId: guild.id,
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            // Stop any existing player/ffmpeg on the connection
            if (connection._currentPlayer) {
                connection._currentPlayer.stop(true);
            }
            if (connection._ffmpegProcess) {
                connection._ffmpegProcess.kill();
                connection._ffmpegProcess = null;
            }

            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });
            connection.subscribe(player);
            connection._currentPlayer = player;

            const localToneFile = require('path').join(__dirname, '5_sec.mp3');
            if (!fs.existsSync(localToneFile)) {
                console.error(`❌ Local drag tone file not found at: ${localToneFile}`);
                return;
            }

            const ffmpegPath = getFfmpegPath();

            // Stream and transcode the local 5_sec.mp3 to s16le PCM, looping infinitely
            const ffmpeg = spawn(ffmpegPath, [
                '-stream_loop', '-1', // Loop infinitely to play for exactly 5 seconds
                '-i', localToneFile,
                '-f', 's16le',
                '-acodec', 'pcm_s16le',
                '-ar', '48000',
                '-ac', '2',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            connection._ffmpegProcess = ffmpeg;

            const resource = createAudioResource(ffmpeg.stdout, {
                inputType: StreamType.Raw
            });

            // Wait for ready state before playing
            await entersState(connection, VoiceConnectionStatus.Ready, 5000).catch(() => {});

            player.play(resource);
            console.log("🔊 [VOICE-DRAG] Started playing tone in 🔒4C_Pʀɪᴠ𝒂𝒕𝒆...");

            let transitioned = false;
            const triggerTransition = async (reason = "Timer") => {
                if (transitioned) return;
                transitioned = true;

                console.log(`🔊 [VOICE-DRAG] Transitioning back to Secured. Reason: ${reason}`);
                
                // Cleanup player & ffmpeg
                player.stop(true);
                if (connection._ffmpegProcess) {
                    connection._ffmpegProcess.kill();
                    connection._ffmpegProcess = null;
                }

                // IMPORTANT: Destroy current connection first for clean state
                connection.intentionalDisconnect = true;
                connection.destroy();
                console.log("🤖 [VOICE-DRAG] Closed tone connection for clean loopback.");

                if (securedChannel) {
                    // Wait 1 second before joining secured channel to let Discord settle
                    setTimeout(() => {
                        console.log(`🤖 [VOICE-DRAG] Rejoining: ${securedChannel.name}`);
                        connectToVoice(securedChannel);
                    }, 1000);
                } else {
                    console.warn("⚠️ [VOICE-DRAG] Loopback failed: Secured channel not found.");
                }
            };

            // Start 5s timer ONLY after it actually starts playing
            player.once(AudioPlayerStatus.Playing, () => {
                console.log("🔊 [VOICE-DRAG] Audio is now playing. Starting 5s countdown...");
                setTimeout(() => triggerTransition("5s Timer"), 5000);
            });

            // SAFETY FALLBACK: Always transition after 10 seconds total, regardless of player state
            setTimeout(() => triggerTransition("Safety Timeout (10s)"), 10000);

            player.once(AudioPlayerStatus.Idle, () => triggerTransition("Audio Finished"));
            player.on('error', err => {
                console.error("❌ [VOICE-DRAG] Player Error:", err);
                triggerTransition("Player Error");
            });
            ffmpeg.on('error', err => console.error("❌ [VOICE-DRAG] FFmpeg Error:", err));

        } catch (err) {
            console.error("❌ [VOICE-DRAG] Sequence Error:", err);
            // Fallback move back
            setTimeout(() => {
                const guild = newState.guild;
                const securedChannel = guild.channels.cache.find(c => c.isVoiceBased() && normalizeChannelName(c.name).includes("secured"));
                if (securedChannel) {
                    connectToVoice(securedChannel);
                }
            }, 2000);
        }
    }
});

// ================= ANTI-SPAM + MENTION DM =================

const promoFile = './promotions.json';
let promoData = {};
if (fs.existsSync(promoFile)) {
    try { promoData = JSON.parse(fs.readFileSync(promoFile, 'utf8')); } catch (e) { }
}

const userMessages = new Map();

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Anti-Link & Weekly Promotion Cooldown System
    const containsLink = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/.test(message.content)
        || /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/.test(message.content.toLowerCase());

    if (containsLink && message.member && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const channelName = message.channel.name ? message.channel.name.toLowerCase() : "";
        const isPromo = channelName.includes("promotion") 
            || message.channel.name.includes("𝑷𝒓𝒐𝒎𝒐𝒕𝒊𝒐𝒏")
            || message.channel.name.includes("ㆍ𝑷𝒓𝒐𝒎𝒐𝒕𝒊𝒐𝒏ㆍ〻");

        if (!isPromo) {
            // Warn in DM
            try {
                await message.author.send(`⚠️ Links are not allowed in **${message.guild.name}** outside of the promotion channel! Your link has been deleted.`);
            } catch (err) {
                console.error("Could not send warning DM to user:", err);
            }

            await message.delete().catch(() => { });
            return;
        } else {
            // IT IS THE PROMO CHANNEL! Enforce 7 day cooldown
            const userId = message.author.id;
            const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
            const now = Date.now();

            if (promoData[userId] && (now - promoData[userId]) < ONE_WEEK) {
                const timeLeft = ONE_WEEK - (now - promoData[userId]);
                const daysLeft = Math.ceil(timeLeft / (1000 * 60 * 60 * 24));

                await message.delete().catch(() => { });
                const alertMsg = await message.channel.send(`⚠️ ${message.author}, you can only advertise your link once a week! Please wait **${daysLeft} days** before posting again.`);
                setTimeout(() => alertMsg.delete().catch(() => { }), 10000);
                return;
            } else {
                // Record timestamp and save to purely local database
                promoData[userId] = now;
                fs.writeFileSync(promoFile, JSON.stringify(promoData));
            }
        }
    }

    const now = Date.now();
    const timestamps = userMessages.get(message.author.id) || [];
    timestamps.push(now);
    userMessages.set(message.author.id, timestamps);



    const filtered = timestamps.filter(t => now - t < antiSpamTime);
    userMessages.set(message.author.id, filtered);

    if (filtered.length >= antiSpamLimit) {
        await message.delete().catch(() => { });

        try {
            // Mute for 12 hours (12 * 60 * 60 * 1000 ms)
            if (message.member && message.member.moderatable) {
                await message.member.timeout(12 * 60 * 60 * 1000, "Spamming detected");
            }

            // Send public message
            await message.channel.send(`🔇 ${message.author} has been muted for 12 hours due to spamming.`);

            // Send DM
            await message.author.send("You have been muted for 12 hours for spamming the server.");
        } catch (err) {
            console.error("Failed to mute/DM user:", err);
            message.channel.send(`${message.author}, please stop spamming! (Note: Failed to apply mute)`);
        }

        // Reset their message count so they don't get muted again continuously
        userMessages.delete(message.author.id);

        return;
    }

    // Grouped user mention alerting — DM ONLY (no public messages)
    const mentionedUsers = message.mentions.users.filter(u => !u.bot && u.id !== message.author.id);
    if (mentionedUsers.size > 0) {
        const messageLink = `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;

        mentionedUsers.forEach(async (user) => {
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle("📬 Mention Alert")
                    .setDescription(`You were mentioned in a server channel.`)
                    .setColor(0x5865F2)
                    .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                    .addFields(
                        { name: "👤 Mentioned By", value: `${message.author.tag}`, inline: true },
                        { name: "🏠 Server", value: `${message.guild.name}`, inline: true },
                        { name: "💬 Channel", value: `#${message.channel.name}`, inline: true },
                        { name: "📝 Message", value: message.content.length > 200 ? message.content.substring(0, 200) + "..." : message.content, inline: false }
                    )
                    .setFooter({ text: "Akaza Notification System" })
                    .setTimestamp();

                const { ActionRowBuilder: AR, ButtonBuilder: BB, ButtonStyle: BS } = require("discord.js");
                const linkBtn = new BB()
                    .setLabel("Jump to Message")
                    .setStyle(BS.Link)
                    .setURL(messageLink);
                const btnRow = new AR().addComponents(linkBtn);

                await user.send({ embeds: [dmEmbed], components: [btnRow] });
            } catch { /* DMs closed — silently ignore */ }
        });
    }

    // When the bot itself is mentioned (AI response)
    if (message.mentions.users.has(client.user.id)) {
        if (!process.env.GROQ_API_KEY) return;
        message.channel.sendTyping();
        try {
            let Groq;
            try {
                Groq = require("groq-sdk");
            } catch {
                return message.reply("AI chat is off on this host (groq-sdk not installed).");
            }
            const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

            // Clean the message by removing the bot's mention ping so the AI doesn't see it
            const userMessage = message.content.replace(`<@${client.user.id}>`, '').trim();
            const lowerMessage = userMessage.toLowerCase();

            // 1. Moderator action: Give a temporary role
            if (lowerMessage.includes("give me a role") || lowerMessage.includes("give me private vc role")) {
                const role = message.guild.roles.cache.find(r => normalizeChannelName(r.name).includes("private"));
                if (!role) return message.reply("❌ The 'Private VC' role does not exist in this server. Please have an Admin create it first!");

                await message.member.roles.add(role);
                return message.reply("✅ Done! I just hooked you up with the Private VC role.");
            }

            // 2. Moderator action: Drag anyone to a private VC
            if (lowerMessage.includes("drag")) {
                // Find a voice channel explicitly scanning for the exact name or the keyword
                const privateChannel = message.guild.channels.cache.find(c => c.isVoiceBased() && normalizeChannelName(c.name).includes("private"));
                if (!privateChannel) return message.reply("❌ I couldn't find a voice channel with '🔒4C_Pʀɪᴠᴀᴛᴇ' or 'private' in its name.");

                const targetUser = message.mentions.members.find(m => m.id !== client.user.id);

                if (targetUser) {
                    if (!targetUser.voice.channel) return message.reply(`❌ ${targetUser.displayName} needs to be in a voice channel first for me to drag them!`);
                    await targetUser.voice.setChannel(privateChannel);
                    return message.reply(`✅ Whoosh! Dragged ${targetUser.displayName} right into the Private VC.`);
                } else if (lowerMessage.includes("drag me")) {
                    if (!message.member.voice.channel) return message.reply("❌ You need to be in a voice channel first!");
                    await message.member.voice.setChannel(privateChannel);
                    return message.reply("✅ Whoosh! Dropped you into the Private VC.");
                }
            }

            // 3. Normal casual conversational AI fallback
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: "You are a casual, laid-back discord user. Do not act like an AI, an assistant, or a robot. Be totally informal, mostly use lowercase, act incredibly chill, and give short responses like a real human testing out the chat. Never say 'how can I help you' or acknowledge you are an AI. Just chat."
                    },
                    { role: "user", content: userMessage || "hey what's up" }
                ],
                model: "llama-3.1-8b-instant", // Always available instant Llama 3.1
                temperature: 0.8,
                max_tokens: 150
            });

            const reply = chatCompletion.choices[0].message.content;
            await message.reply(reply);
        } catch (err) {
            console.error("Groq AI Error:", err);
        }
    }

    // Admin warning
    if (
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) &&
        message.content.toLowerCase().includes("delete")
    ) {
        message.channel.send("⚠️ Dangerous action detected.");
    }
});

// ================= SLASH HANDLER =================

client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
        const [action, , targetId] = interaction.customId.split("_");

        if (action === "drag") {
            try {
                await interaction.deferUpdate();
                const isYes = interaction.customId.includes("yes");

                // Fetch the guild manually since interaction.guild is null in DMs
                const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
                if (!guild) {
                    return interaction.followUp({ content: "❌ Could not find the server.", ephemeral: true });
                }

                const member = await guild.members.fetch(targetId).catch(() => null);

                if (!member) {
                    return interaction.followUp({ content: "❌ Member not found (they might have left the server).", ephemeral: true });
                }

                if (isYes) {
                    const privateChannel = guild.channels.cache.find(c => c.isVoiceBased() && normalizeChannelName(c.name).includes("private"));
                    if (!privateChannel) {
                        return interaction.followUp({ content: "❌ Target VC (🔒4C_Pʀɪᴠᴀᴛᴇ) not found.", ephemeral: true });
                    }

                    if (!member.voice.channel) {
                        return interaction.followUp({ content: "❌ User is no longer in a voice channel.", ephemeral: true });
                    }

                    await member.voice.setChannel(privateChannel);
                    await interaction.editReply({ content: `✅ Dragged **${member.user.tag}** to ${privateChannel.name}.`, components: [] });
                } else {
                    await interaction.editReply({ content: `❌ Denied drag for **${member.user.tag}**.`, components: [] });
                }
            } catch (err) {
                console.error("Button handling error:", err);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: "❌ An error occurred while handling this action.", ephemeral: true });
                }
            }
        }
        return;
    }

    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== "play") return;
        const focused = interaction.options.getFocused(true);
        const q = (focused.value || "").trim();
        if (q.length < 2) {
            return interaction.respond([]);
        }
        try {
            const videos = await searchYoutube(q, 25);
            const choices = videos.map((v) => ({
                name: v.title.slice(0, 100),
                value: `${v.id}|${v.title}`.slice(0, 100)
            }));
            return interaction.respond(choices);
        } catch (err) {
            console.error("Play autocomplete error:", err);
            return interaction.respond([]);
        }
    }

    if (!interaction.isChatInputCommand()) return;

    try {

        if (interaction.commandName === "ping") {
            return interaction.reply("🏓 Pong! I am online.");
        }

        if (interaction.commandName === "join") {
            await interaction.deferReply();
            const channel = interaction.member.voice.channel;
            if (!channel) {
                return interaction.editReply({
                    content: "❌ Join a voice channel first."
                });
            }

            connectToVoice(channel);
            return interaction.editReply("🔊 Joined your voice channel! 24/7 mode active.");
        }

        if (interaction.commandName === "leave") {

            const connection = getVoiceConnection(interaction.guild.id);

            if (!connection) {
                return interaction.reply({
                    content: "❌ I am not in a voice channel.",
                    ephemeral: true
                });
            }

            connection.intentionalDisconnect = true;
            connection.destroy();
            return interaction.reply("👋 Left the voice channel.");
        }

        if (interaction.commandName === "play") {
            const query = interaction.options.getString("song");
            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.reply({ content: "❌ Join a voice channel first.", ephemeral: true });
            }

            await interaction.deferReply();

            let connection = ensureBotInVoiceChannel(interaction.guild.id, channel);
            await entersState(connection, VoiceConnectionStatus.Ready, 15_000).catch(() => {});

            stopVoicePlayback(connection);
            connection._isMusicPlay = false;

            try {
                const parsed = parsePlayChoice(query);
                let videoUrl = parsed.url;
                let title = parsed.title;

                if (!videoUrl) {
                    const results = await searchYoutube(parsed.query || query, 1);
                    const video = results[0];
                    if (!video) return interaction.editReply("❌ Song not found! Pick one from the list or try another search.");
                    videoUrl = video.url;
                    title = video.title;
                }

                await interaction.editReply(`🎶 Now playing: **${title || "Unknown"}**`);

                console.log(`🎶 Streaming via yt-dlp: ${videoUrl}`);
                await streamYoutubeToConnection(connection, videoUrl);
            } catch (err) {
                console.error("Play error:", err);
                if (interaction.deferred || interaction.replied) {
                    return interaction.editReply("❌ Could not play audio for that song. Pick another from the list.");
                }
                return interaction.reply("❌ Could not play that song. Pick one from the suggestions.");
            }
        }

        if (interaction.commandName === "lag") {
            await interaction.deferReply();
            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.editReply({ content: "❌ Join a voice channel first." });
            }

            const lagFile = require('path').join(__dirname, 'lag.mpeg');
            if (!fs.existsSync(lagFile)) {
                return interaction.editReply({ content: "❌ `lag.mpeg` not found in the bot's root folder." });
            }

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                connection = connectToVoice(channel);
            }

            // Stop any existing player or ffmpeg process
            if (connection._currentPlayer) {
                connection._currentPlayer.stop(true);
            }
            if (connection._ffmpegProcess) {
                connection._ffmpegProcess.kill();
                connection._ffmpegProcess = null;
            }

            connection._isLagLoop = true;
            connection._isDumpLoop = false;

            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });
            connection.subscribe(player);
            connection._currentPlayer = player;

            player.on('stateChange', (oldState, newState) => {
                console.log(`🎵 Lag AudioPlayer state: ${oldState.status} -> ${newState.status}`);
            });

            player.on('error', error => console.error("🎵 Lag Audio Player Error:", error));

            // Use FFmpeg to transcode .mpeg → raw PCM and stream loop infinitely
            const ffmpegPath = getFfmpegPath();

            try {
                const ffmpeg = spawn(ffmpegPath, [
                    '-stream_loop', '-1', // Loop infinitely in FFmpeg
                    '-i', lagFile,
                    '-f', 's16le',       // Output raw PCM 16-bit signed Little-Endian
                    '-acodec', 'pcm_s16le',
                    '-ar', '48000',      // Sample rate: 48kHz (Discord standard)
                    '-ac', '2',          // Stereo
                    'pipe:1'
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                connection._ffmpegProcess = ffmpeg;

                ffmpeg.stderr.on('data', (data) => {
                    console.log(`[FFmpeg STDERR] ${data.toString()}`);
                });

                ffmpeg.on('error', err => console.error("FFmpeg spawn error:", err));
                ffmpeg.on('close', (code) => {
                    if (code !== null && code !== 0) console.error(`FFmpeg exited with code ${code}`);
                });

                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw
                });

                player.play(resource);
                console.log("🔊 Lag: Loop streaming via FFmpeg (raw PCM s16le)");

                return interaction.editReply("🔁 LAG mode activated! Playing `lag.mpeg` on loop. Use `/stop` to stop.");
            } catch (err) {
                console.error("Lag stream start error:", err);
                return interaction.editReply("❌ Failed to start the lag audio stream.");
            }
        }

        if (interaction.commandName === "dump") {
            // Check if user is bot owner (via .env OWNER_ID or dynamically dynamic Guild Creator fallback)
            const isOwner = (OWNER_ID && interaction.user.id === OWNER_ID) || interaction.user.id === interaction.guild.ownerId;
            if (!isOwner) {
                return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
            }

            await interaction.deferReply();
            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.editReply({ content: "❌ Join a voice channel first." });
            }

            const dumpFile = require('path').join(__dirname, 'dump.mpeg');
            if (!fs.existsSync(dumpFile)) {
                return interaction.editReply({ content: "❌ `dump.mpeg` not found in the bot's root folder." });
            }

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                connection = connectToVoice(channel);
            }

            // Stop any existing player or ffmpeg process
            if (connection._currentPlayer) {
                connection._currentPlayer.stop(true);
            }
            if (connection._ffmpegProcess) {
                connection._ffmpegProcess.kill();
                connection._ffmpegProcess = null;
            }

            connection._isDumpLoop = true;
            connection._isLagLoop = false;

            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });
            connection.subscribe(player);
            connection._currentPlayer = player;

            player.on('stateChange', (oldState, newState) => {
                console.log(`🎵 Dump AudioPlayer state: ${oldState.status} -> ${newState.status}`);
            });

            player.on('error', error => console.error("🎵 Dump Audio Player Error:", error));

            // Use FFmpeg to transcode .mpeg → raw PCM and stream loop infinitely
            const ffmpegPath = getFfmpegPath();

            try {
                const ffmpeg = spawn(ffmpegPath, [
                    '-stream_loop', '-1', // Loop infinitely in FFmpeg
                    '-i', dumpFile,
                    '-f', 's16le',       // Output raw PCM 16-bit signed Little-Endian
                    '-acodec', 'pcm_s16le',
                    '-ar', '48000',      // Sample rate: 48kHz (Discord standard)
                    '-ac', '2',          // Stereo
                    'pipe:1'
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                connection._ffmpegProcess = ffmpeg;

                ffmpeg.stderr.on('data', (data) => {
                    console.log(`[FFmpeg STDERR] ${data.toString()}`);
                });

                ffmpeg.on('error', err => console.error("FFmpeg spawn error:", err));
                ffmpeg.on('close', (code) => {
                    if (code !== null && code !== 0) console.error(`FFmpeg exited with code ${code}`);
                });

                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw
                });

                player.play(resource);
                console.log("🔊 Dump: Loop streaming via FFmpeg (raw PCM s16le)");

                return interaction.editReply("🔁 DUMP mode activated! Playing `dump.mpeg` on loop. Use `/stop` to stop.");
            } catch (err) {
                console.error("Dump stream start error:", err);
                return interaction.editReply("❌ Failed to start the dump audio stream.");
            }
        }

        if (interaction.commandName === "up") {
            const hasRole = interaction.member.roles.cache.some(r => r.name === "Bot Command");
            if (!hasRole && !isBotOwner(interaction.user, interaction.guild)) {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle("Permission Denied")
                        .setDescription("You need the **Bot Command** role to use this command.")
                        .setColor(0xe74c3c)
                    ],
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user", true);
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });
            }
            
            // Check if already in loop
            const existing = upLoops.get(interaction.guild.id);
            if (existing && existing.targetId === member.id && existing.active) {
                return interaction.reply({ content: `❌ A loop is already active for **${member.displayName}**.`, ephemeral: true });
            }

            const { general, music } = findUpLoopChannels(interaction.guild);
            if (!general || !music) {
                return interaction.reply({
                    content: "❌ Could not find General VC or Music channel.",
                    ephemeral: true
                });
            }

            startUpLoop(interaction.guild, member, [general, music], interaction.user);
            
            const startEmbed = new EmbedBuilder()
                .setTitle("Voice Drag Started")
                .setDescription(`**${member.displayName}** is now being moved continuously between **${general.name}** and **${music.name}**.`)
                .setColor(0x27ae60)
                .setTimestamp();

            return interaction.reply({ embeds: [startEmbed] });
        }

        if (interaction.commandName === "down") {
            const hasRole = interaction.member.roles.cache.some(r => r.name === "Bot Command");
            if (!hasRole && !isBotOwner(interaction.user, interaction.guild)) {
                return interaction.reply({
                    embeds: [new EmbedBuilder()
                        .setTitle("Permission Denied")
                        .setDescription("You need the **Bot Command** role to use this command.")
                        .setColor(0xe74c3c)
                    ],
                    ephemeral: true
                });
            }

            const target = interaction.options.getUser("user", true);
            const loop = upLoops.get(interaction.guild.id);
            
            if (!loop || loop.targetId !== target.id) {
                return interaction.reply({ content: `❌ No active loop found for **${target.username}**.`, ephemeral: true });
            }

            stopUpLoop(interaction.guild.id);
            logModerationAction(interaction.guild, "Voice Drag Stopped", interaction.user, target);

            const stopEmbed = new EmbedBuilder()
                .setTitle("Voice Drag Stopped")
                .setDescription(`Continuous movement has been disabled for **${target.username}**.`)
                .setColor(0xe74c3c)
                .setTimestamp();

            return interaction.reply({ embeds: [stopEmbed] });
        }

        if (interaction.commandName === "stop") {
            const connection = getVoiceConnection(interaction.guild.id);

            if (!connection) {
                return interaction.reply({ content: "❌ I'm not in a voice channel.", ephemeral: true });
            }

            connection._isLagLoop = false;
            connection._isDumpLoop = false;
            stopVoicePlayback(connection);
            connection.intentionalDisconnect = true;
            connection.destroy();

            return interaction.reply("⏹️ Stopped and disconnected.");
        }

        if (interaction.commandName === "testplay") {
            await interaction.deferReply();
            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.editReply({ content: "❌ Join a voice channel first." });
            }

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                connection = connectToVoice(channel);
            }

            // Stop any existing player or ffmpeg process
            if (connection._currentPlayer) {
                connection._currentPlayer.stop(true);
            }
            if (connection._ffmpegProcess) {
                connection._ffmpegProcess.kill();
                connection._ffmpegProcess = null;
            }

            const player = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Play }
            });
            connection.subscribe(player);
            connection._currentPlayer = player;

            player.on('stateChange', (oldState, newState) => {
                console.log(`🎵 TestPlay AudioPlayer state: ${oldState.status} -> ${newState.status}`);
            });

            player.on('error', error => console.error("🎵 TestPlay Audio Player Error:", error));

            const sampleUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
            const ffmpegPath = getFfmpegPath();

            try {
                console.log(`🔊 TestPlay: Spawning FFmpeg to stream from ${sampleUrl}`);
                const ffmpeg = spawn(ffmpegPath, [
                    '-i', sampleUrl,
                    '-f', 's16le',
                    '-acodec', 'pcm_s16le',
                    '-ar', '48000',
                    '-ac', '2',
                    'pipe:1'
                ], { stdio: ['ignore', 'pipe', 'pipe'] });

                connection._ffmpegProcess = ffmpeg;

                ffmpeg.stderr.on('data', (data) => {
                    console.log(`[TestPlay FFmpeg STDERR] ${data.toString()}`);
                });

                ffmpeg.on('error', err => console.error("TestPlay FFmpeg spawn error:", err));
                ffmpeg.on('close', (code) => {
                    if (code !== null && code !== 0) console.error(`TestPlay FFmpeg exited with code ${code}`);
                });

                const resource = createAudioResource(ffmpeg.stdout, {
                    inputType: StreamType.Raw
                });

                player.play(resource);
                console.log("🔊 TestPlay: Playing sample audio via FFmpeg (raw PCM s16le)");

                return interaction.editReply("🔊 Playing sample audio from SoundHelix! Check if you can hear it.");
            } catch (err) {
                console.error("TestPlay stream start error:", err);
                return interaction.editReply("❌ Failed to start the sample audio stream.");
            }
        }

    } catch (err) {
        console.error("Interaction error:", err);

        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply("❌ Error occurred (interaction already acknowledged).").catch(() => { });
            } else {
                await interaction.reply({ content: "❌ Error occurred.", ephemeral: true }).catch(() => { });
            }
        } catch (innerErr) {
            console.error("Failed to send error reply:", innerErr);
        }
    }
});

// ================= GLOBAL ERROR HANDLER =================

client.on("error", console.error);
process.on("unhandledRejection", console.error);

// ================= LOGIN =================

client.login(TOKEN).catch((err) => {
    require("fs").writeFileSync("login_error.txt", err.toString() + "\n" + err.stack);
    console.error("CRITICAL LOGIN ERROR:", err);
});

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// Prevent Railway from thinking app is done
setInterval(() => { }, 1000);
