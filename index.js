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
    getVoiceConnection
} = require("@discordjs/voice");

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
        .setDescription("Leave voice channel")
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

    const now = Date.now();
    const timestamps = userMessages.get(message.author.id) || [];
    timestamps.push(now);
    userMessages.set(message.author.id, timestamps);

    const filtered = timestamps.filter(t => now - t < antiSpamTime);
    userMessages.set(message.author.id, filtered);

    if (filtered.length >= antiSpamLimit) {
        await message.delete().catch(() => {});
        message.channel.send(`${message.author}, stop spamming!`);
        return;
    }

    // DM when mentioned
    message.mentions.users.forEach(async (user) => {
        if (!user.bot) {
            try {
                await user.send(
                    `🔔 You were mentioned in #${message.channel.name}\n\n${message.content}`
                );
            } catch {}
        }
    });

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

client.login(TOKEN);
