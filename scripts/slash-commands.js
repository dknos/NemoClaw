// slash-commands.js — Slash command definitions and registration for MrBigPipes AI
"use strict";

const { SlashCommandBuilder, REST, Routes } = (() => {
  const djs = require(require("path").resolve(__dirname, "../node_modules/discord.js"));
  return { SlashCommandBuilder: djs.SlashCommandBuilder, REST: djs.REST, Routes: djs.Routes };
})();

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all commands and how to use MrBigPipes AI"),

  new SlashCommandBuilder()
    .setName("grok")
    .setDescription("Generate an image with Grok Aurora (xAI)")
    .addStringOption(o => o.setName("prompt").setDescription("What to generate").setRequired(true)),

  new SlashCommandBuilder()
    .setName("grok-img2img")
    .setDescription("Grok image-to-image: upload a source image, get AI variations")
    .addAttachmentOption(o => o.setName("image").setDescription("Source image to use as reference").setRequired(true))
    .addStringOption(o => o.setName("prompt").setDescription("Describe the desired output").setRequired(true)),

  new SlashCommandBuilder()
    .setName("grok-img2vid")
    .setDescription("Grok image-to-video: upload an image, animate it")
    .addAttachmentOption(o => o.setName("image").setDescription("Source image to animate").setRequired(true))
    .addStringOption(o => o.setName("prompt").setDescription("Describe the motion / animation").setRequired(true)),

  new SlashCommandBuilder()
    .setName("zturbo")
    .setDescription("Generate an image locally with ZImage Turbo (fast, runs on your GPU)")
    .addStringOption(o => o.setName("prompt").setDescription("What to generate").setRequired(true))
    .addStringOption(o => o.setName("style").setDescription("Visual style to apply (default: none)")
      .addChoices(
        { name: "None",                   value: "none" },
        { name: "80s Dark Fantasy Photo", value: "80s-dark-fantasy" },
        { name: "Synthwave Photo",        value: "synthwave" },
        { name: "Witchcore Photo",        value: "witchcore" },
        { name: "Light Painting Photo",   value: "light-painting" },
        { name: "Kawaii Pop Photo",       value: "kawaii-pop" },
        { name: "Spotlight Stage Photo",  value: "spotlight-stage" },
        { name: "Post-Processed Artistry",value: "post-processed" },
        { name: "Low-Poly Render",        value: "low-poly" },
        { name: "Ink Draw",               value: "ink-draw" },
        { name: "Shadow Fantasy Illus.",  value: "shadow-fantasy" },
        { name: "Gothic Engraving",       value: "gothic-engraving" },
        { name: "Folk-Art Mosaic",        value: "folk-art-mosaic" },
        { name: "Paper-Cut Diorama",      value: "paper-cut" },
        { name: "Risograph Print",        value: "risograph" },
        { name: "Modern Ukiyo-e Print",   value: "ukiyo-e" },
        { name: "Vintage Polaroid Photo", value: "vintage-polaroid" },
        { name: "Glass Encased Advert.",  value: "glass-advertising" },
        { name: "Vintage VGA Monitor",    value: "vintage-vga" },
      )),

  new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Generate an image with Imagen 4 Fast")
    .addStringOption(o => o.setName("prompt").setDescription("What to generate").setRequired(true))
    .addStringOption(o => o.setName("ratio").setDescription("Aspect ratio")
      .addChoices(
        { name: "1:1 (Square)", value: "1:1" },
        { name: "16:9 (Landscape)", value: "16:9" },
        { name: "9:16 (Portrait)", value: "9:16" },
        { name: "4:3 (Classic)", value: "4:3" },
        { name: "3:4 (Portrait Classic)", value: "3:4" },
        { name: "3:2 (Photo)", value: "3:2" },
      )),

  new SlashCommandBuilder()
    .setName("video")
    .setDescription("Generate a text-to-video clip with LTX 2.3")
    .addStringOption(o => o.setName("prompt").setDescription("Describe the video scene in detail").setRequired(true)),

  new SlashCommandBuilder()
    .setName("combi")
    .setDescription("First/last frame video — attach 2 images")
    .addStringOption(o => o.setName("prompt").setDescription("Describe the transition between frames").setRequired(true)),

  new SlashCommandBuilder()
    .setName("story")
    .setDescription("Multi-segment story video (chained narrative)")
    .addStringOption(o => o.setName("plot").setDescription("Full story arc — bot will break into segments").setRequired(true))
    .addIntegerOption(o => o.setName("segments").setDescription("Number of 10s segments (2-4)").setMinValue(2).setMaxValue(4)),

  new SlashCommandBuilder()
    .setName("music")
    .setDescription("Generate a song with ACE-Step")
    .addStringOption(o => o.setName("tags").setDescription("Style: genre, tempo, instruments, vocal style").setRequired(true))
    .addStringOption(o => o.setName("lyrics").setDescription("Song lyrics with [verse] [chorus] markers").setRequired(true))
    .addIntegerOption(o => o.setName("duration").setDescription("Duration in seconds (default 60, max 120)").setMinValue(15).setMaxValue(120)),

  new SlashCommandBuilder()
    .setName("suno")
    .setDescription("Generate a song with Suno AI")
    .addStringOption(o => o.setName("prompt").setDescription("Describe the song: style, mood, genre, vibe").setRequired(true))
    .addStringOption(o => o.setName("tags").setDescription("Style tags e.g. 'lo-fi chill piano rain'"))
    .addBooleanOption(o => o.setName("instrumental").setDescription("No vocals (default false)"))
    .addStringOption(o => o.setName("lyrics").setDescription("Custom lyrics to use (paste full lyrics; prompt becomes the song title)"))
    .addBooleanOption(o => o.setName("gen_lyrics").setDescription("Auto-generate lyrics from your prompt first, then make the song"))
    .addStringOption(o => o.setName("model").setDescription("Suno model version (default: v5.5)")
      .addChoices(
        { name: "v5.5 (default)", value: "chirp-fenix" },
        { name: "v5",             value: "chirp-crow"  },
      )),

  new SlashCommandBuilder()
    .setName("post")
    .setDescription("Post last generated media to Instagram")
    .addStringOption(o => o.setName("caption").setDescription("Custom caption (auto-generated if empty)"))
    .addStringOption(o => o.setName("channel").setDescription("Where to post")
      .addChoices(
        { name: "Instagram", value: "instagram" },
        { name: "YouTube", value: "youtube" },
        { name: "Both", value: "instagram,youtube" },
      )),

  new SlashCommandBuilder()
    .setName("yt")
    .setDescription("Search a YouTube channel's recent videos")
    .addStringOption(o => o.setName("channel").setDescription("Channel name or ID").setRequired(true))
    .addStringOption(o => o.setName("type").setDescription("Content type")
      .addChoices(
        { name: "All Videos", value: "all" },
        { name: "Livestreams", value: "live" },
      ))
    .addIntegerOption(o => o.setName("max").setDescription("Number of results (default 5)").setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName("transcript")
    .setDescription("Get and summarize a YouTube video transcript")
    .addStringOption(o => o.setName("url").setDescription("YouTube video URL").setRequired(true)),

  new SlashCommandBuilder()
    .setName("analyze")
    .setDescription("Batch analyze a channel's recent streams")
    .addStringOption(o => o.setName("channel").setDescription("Channel name").setRequired(true))
    .addIntegerOption(o => o.setName("count").setDescription("Number of videos (default 10)").setMinValue(1).setMaxValue(20))
    .addStringOption(o => o.setName("type").setDescription("Content type")
      .addChoices(
        { name: "All Videos", value: "all" },
        { name: "Livestreams", value: "live" },
      )),

  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Talk to MrBigPipes AI")
    .addStringOption(o => o.setName("message").setDescription("Your message").setRequired(true)),

  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Show current AI models being used"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show ComfyUI render queue status"),

  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask anything about Netify/PipeBox/MrBigPipes AI (grounded search)")
    .addStringOption(o => o.setName("query").setDescription("Your question").setRequired(true)),

  new SlashCommandBuilder()
    .setName("combine")
    .setDescription("Replace a video's audio track with an uploaded audio file")
    .addAttachmentOption(o => o.setName("video").setDescription("Video file (mp4, mov, webm...)").setRequired(true))
    .addAttachmentOption(o => o.setName("audio").setDescription("Audio file to use as soundtrack (mp3, wav, ogg...)").setRequired(true)),

  new SlashCommandBuilder()
    .setName("trim")
    .setDescription("Trim a video or audio clip (e.g. 10s-end, 0:30-1:15)")
    .addAttachmentOption(o => o.setName("file").setDescription("Video or audio file").setRequired(true))
    .addStringOption(o => o.setName("start").setDescription("Start time (e.g. 10s, 0:30, 1:15.5) — default: 0s"))
    .addStringOption(o => o.setName("end").setDescription("End time (e.g. 45s, 1:30, end) — default: end")),

  new SlashCommandBuilder()
    .setName("edit")
    .setDescription("Compose a video from images, clips, and music")
    .addStringOption(o => o.setName("preset").setDescription("Video format")
      .addChoices(
        { name: "Short (14s, 9:16)", value: "short" },
        { name: "Vertical (60s, 9:16)", value: "vertical" },
        { name: "Vertical Long (120s, 9:16)", value: "vertical-long" },
        { name: "Full (60s, 16:9)", value: "full" },
        { name: "Long (120s, 16:9)", value: "full-long" },
      ))
    .addStringOption(o => o.setName("style").setDescription("Visual style")
      .addChoices(
        { name: "Cinematic", value: "cinematic" },
        { name: "Vibrant", value: "vibrant" },
        { name: "Moody", value: "moody" },
        { name: "Vintage", value: "vintage" },
        { name: "Dark", value: "dark" },
        { name: "Dreamy", value: "dreamy" },
        { name: "Brainslop (jumpcuts, beat-synced)", value: "brainslop" },
        { name: "Ludicrous (pure chaos)", value: "ludicrous" },
      ))
    .addStringOption(o => o.setName("caption").setDescription("Text overlay (shown first 4s)"))
    .addStringOption(o => o.setName("lyrics").setDescription("Add auto-transcribed lyrics/captions")
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Karaoke (word-by-word highlight)", value: "karaoke" },
        { name: "Subtitles (standard)", value: "subtitles" },
        { name: "Viral (big single words)", value: "viral" },
      ))
    .addBooleanOption(o => o.setName("beattrack").setDescription("Sync cuts to detected beats in audio"))
    .addAttachmentOption(o => o.setName("media1").setDescription("Image or video file"))
    .addAttachmentOption(o => o.setName("media2").setDescription("Second image or video"))
    .addAttachmentOption(o => o.setName("media3").setDescription("Third image or video"))
    .addAttachmentOption(o => o.setName("media4").setDescription("Fourth image or video"))
    .addAttachmentOption(o => o.setName("audio").setDescription("Music track (mp3, wav, ogg)")),

  new SlashCommandBuilder()
    .setName("edit-add")
    .setDescription("Add media to your edit queue (call multiple times for 10+ files)")
    .addAttachmentOption(o => o.setName("media1").setDescription("Image, video, or audio file").setRequired(true))
    .addAttachmentOption(o => o.setName("media2").setDescription("Second file"))
    .addAttachmentOption(o => o.setName("media3").setDescription("Third file"))
    .addAttachmentOption(o => o.setName("media4").setDescription("Fourth file"))
    .addAttachmentOption(o => o.setName("media5").setDescription("Fifth file")),

  new SlashCommandBuilder()
    .setName("edit-go")
    .setDescription("Render your edit queue into a video")
    .addStringOption(o => o.setName("preset").setDescription("Video format")
      .addChoices(
        { name: "Short (14s, 9:16)", value: "short" },
        { name: "Vertical (60s, 9:16)", value: "vertical" },
        { name: "Vertical Long (120s, 9:16)", value: "vertical-long" },
        { name: "Full (60s, 16:9)", value: "full" },
        { name: "Long (120s, 16:9)", value: "full-long" },
      ))
    .addStringOption(o => o.setName("style").setDescription("Visual style")
      .addChoices(
        { name: "Cinematic", value: "cinematic" },
        { name: "Vibrant", value: "vibrant" },
        { name: "Moody", value: "moody" },
        { name: "Vintage", value: "vintage" },
        { name: "Dark", value: "dark" },
        { name: "Dreamy", value: "dreamy" },
        { name: "Brainslop (jumpcuts, beat-synced)", value: "brainslop" },
        { name: "Ludicrous (pure chaos)", value: "ludicrous" },
      ))
    .addStringOption(o => o.setName("caption").setDescription("Text overlay (shown first 4s)")),

  new SlashCommandBuilder()
    .setName("edit-queue")
    .setDescription("Show what's in your edit queue"),

  new SlashCommandBuilder()
    .setName("edit-clear")
    .setDescription("Clear your edit queue"),

  new SlashCommandBuilder()
    .setName("capcut")
    .setDescription("Compose a video with CapCut effects & transitions (premium quality)")
    .addStringOption(o => o.setName("preset").setDescription("Video format")
      .addChoices(
        { name: "Short (14s, 9:16)", value: "short" },
        { name: "Vertical (60s, 9:16)", value: "vertical" },
        { name: "Vertical Long (120s, 9:16)", value: "vertical-long" },
        { name: "Full (60s, 16:9)", value: "full" },
        { name: "Long (120s, 16:9)", value: "full-long" },
      ))
    .addStringOption(o => o.setName("style").setDescription("Visual style")
      .addChoices(
        { name: "Cinematic", value: "cinematic" },
        { name: "Vibrant", value: "vibrant" },
        { name: "Moody", value: "moody" },
        { name: "Vintage", value: "vintage" },
        { name: "Dark", value: "dark" },
        { name: "Dreamy", value: "dreamy" },
        { name: "Brainslop (beat-synced)", value: "brainslop" },
        { name: "Ludicrous (chaos)", value: "ludicrous" },
      ))
    .addStringOption(o => o.setName("lyrics").setDescription("Auto-transcribed lyrics/captions")
      .addChoices(
        { name: "Off", value: "off" },
        { name: "Karaoke (word-by-word)", value: "karaoke" },
        { name: "Subtitles (standard)", value: "subtitles" },
        { name: "Viral (big single words)", value: "viral" },
      ))
    .addBooleanOption(o => o.setName("beattrack").setDescription("Sync cuts to detected beats"))
    .addStringOption(o => o.setName("render").setDescription("Render mode")
      .addChoices(
        { name: "CapCut Desktop (real effects)", value: "desktop" },
        { name: "FFmpeg (fast, approximate)", value: "render" },
        { name: "Draft only (open in CapCut)", value: "draft" },
      ))
    .addStringOption(o => o.setName("caption").setDescription("Text overlay"))
    .addAttachmentOption(o => o.setName("media1").setDescription("Image or video file"))
    .addAttachmentOption(o => o.setName("media2").setDescription("Second file"))
    .addAttachmentOption(o => o.setName("media3").setDescription("Third file"))
    .addAttachmentOption(o => o.setName("media4").setDescription("Fourth file"))
    .addAttachmentOption(o => o.setName("audio").setDescription("Music track (mp3, wav, ogg)")),

  new SlashCommandBuilder()
    .setName("create")
    .setDescription("Create image, video, or audio — pick a type and model"),
];

async function registerCommands(token, clientId) {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log(`[slash] registering ${commands.length} commands...`);
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands.map(c => c.toJSON()),
    });
    console.log(`[slash] ${commands.length} commands registered globally`);
  } catch (e) {
    console.error(`[slash] registration failed:`, e.message);
  }
}

module.exports = { commands, registerCommands };
