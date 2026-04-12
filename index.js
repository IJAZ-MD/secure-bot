require('dotenv').config();
try { process.env.FFMPEG_PATH = require('ffmpeg-static'); } catch (e) { }
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("Bot is running");
});

app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
});


const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField
} = require("discord.js");

const {
    joinVoiceChannel,
    getVoiceConnection,
    createAudioPlayer,
    createAudioResource,
    NoSubscriberBehavior,
    AudioPlayerStatus,
    entersState,
    VoiceConnectionStatus
} = require("@discordjs/voice");
const playdl = require("play-dl");

// ================= CONFIG =================

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const autoRoleName = "Member";
const antiSpamLimit = 5;
const antiSpamTime = 5000;

// ================= CLIENT =================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
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
        .setDescription("Play a song from YouTube or Soundcloud")
        .addStringOption(option =>
            option.setName("song")
                .setDescription("Search query or URL")
                .setRequired(true))
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

client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);

    client.user.setPresence({
        activities: [{ name: "4CZ Secure 24/7 🔥" }],
        status: "online"
    });
});

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

// ================= ANTI-SPAM + MENTION DM =================

const userMessages = new Map();

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Anti-Link System (Except Admin & Promotion Channels)
    const containsLink = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/.test(message.content)
        || /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/.test(message.content.toLowerCase());

    if (containsLink && message.member && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const channelName = message.channel.name ? message.channel.name.toLowerCase() : "";
        if (!channelName.includes("promotion") && !message.channel.name.includes("𝑷𝒓𝒐𝒎𝒐𝒕𝒊𝒐𝒏")) {
            await message.delete().catch(() => { });
            const alertMsg = await message.channel.send(`⚠️ ${message.author}, links are not allowed here! Please post them in the promotion channel.`);
            setTimeout(() => alertMsg.delete().catch(() => { }), 5000);
            return;
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

    // Grouped user mention alerting
    const mentionedUsers = message.mentions.users.filter(u => !u.bot && u.id !== message.author.id);
    if (mentionedUsers.size > 0) {
        const userTags = mentionedUsers.map(u => u.toString()).join(", ");
        await message.channel.send(`🔔 ${userTags}, you have been mentioned by ${message.author}! Please check your DMs.`).catch(() => { });

        mentionedUsers.forEach(async (user) => {
            try {
                await user.send(
                    `🔔 You were mentioned in #${message.channel.name} by ${message.author.tag}:\n\n${message.content}`
                );
            } catch { }
        });
    }

    // When the bot itself is mentioned
    if (message.mentions.users.has(client.user.id)) {
        await message.channel.send(`Hello ${message.author}, how can I help you? I also sent you a DM!`);
        try {
            await message.author.send(`You mentioned me in #${message.channel.name}! I am the 4CZ Secure 24/7 bot. Try using my slash commands like /ping.`);
        } catch (err) {
            console.error("Could not DM user who mentioned bot.");
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
    if (!interaction.isChatInputCommand()) return;

    try {

        if (interaction.commandName === "ping") {
            return interaction.reply("🏓 Pong! I am online.");
        }

        if (interaction.commandName === "join") {

            const channel = interaction.member.voice.channel;

            if (!channel) {
                return interaction.reply({
                    content: "❌ Join a voice channel first.",
                    ephemeral: true
                });
            }

            joinVoiceChannel({
                channelId: channel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator
            });

            return interaction.reply("🔊 Joined your voice channel!");
        }

        if (interaction.commandName === "leave") {

            const connection = getVoiceConnection(interaction.guild.id);

            if (!connection) {
                return interaction.reply({
                    content: "❌ I am not in a voice channel.",
                    ephemeral: true
                });
            }

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

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false
                });
            }

            try {
                // Search up using yt-search to bypass blocks
                const ytSearch = require("yt-search");
                const ytdl = require("@distube/ytdl-core");

                // Check if query is a URL or search text
                const r = await ytSearch(query);
                const video = r.videos.length > 0 ? r.videos[0] : null;

                if (!video) {
                    return interaction.editReply("❌ Song not found!");
                }

                // Streaming via distube wrapper that dodges "Sign in" errors
                const stream = ytdl(video.url, {
                    filter: "audioonly",
                    quality: "highestaudio",
                    highWaterMark: 1 << 25
                });

                const resource = createAudioResource(stream);

                const player = createAudioPlayer({
                    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
                });

                player.play(resource);
                connection.subscribe(player);

                player.on('error', error => {
                    console.error("Audio Player Error:", error);
                });

                return interaction.editReply(`🎶 Now playing: **${video.title}**`);
            } catch (err) {
                console.error("Play error:", err);
                return interaction.editReply("❌ An error occurred while trying to play the song.");
            }
        }

    } catch (err) {
        console.error("Interaction error:", err);

        if (interaction.replied || interaction.deferred) {
            await interaction.editReply("❌ Error occurred.");
        } else {
            await interaction.reply("❌ Error occurred.");
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

