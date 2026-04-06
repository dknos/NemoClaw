// Bridge utility functions — extracted for testability.
// Pure logic only, no side effects, no Discord/Node dependencies.

const COMMAND_PATTERNS = [
  /\brestart\b/i,
  /\breboot\b/i,
  /start[-_]?all/i,
  /\bshutdown\b/i,
  /\bkill\b.*\bbot\b/i,
  /\bbash\b/i,
  /\bsudo\b/i,
  /\bssh\b/i,
  /\bexec(ute)?\b/i,
  /run.*\.sh\b/i,
  /\bpkill\b/i,
  /\bsystemctl\b/i,
  /ignore (your|the) (instructions|rules|system)/i,
  /forget (your|the) (instructions|rules|system)/i,
  /you are now/i,
  /new (system prompt|instructions|persona|role)/i,
  /override (your|the)/i,
];

function stripCommands(s) {
  return (s || "").replace(/python3?\s+\/\S+/g, "").replace(/\bexec\s*\([\s\S]*?\)/gi, "").replace(/\bexec\s*\(["']?/gi, "").replace(/["']?\s*\)\s*$/g, "").replace(/\/(?:tmp|sandbox|home|workspace)\S+/g, "").replace(/\[.*?\]/g, "").replace(/```[\s\S]*?```/g, "").split("\n").filter(l => !l.match(/^\s*(python3?|exec|bash|sh)\s/i)).join("\n").trim();
}

function extractImagePaths(text) {
  const matches = text.match(/\/tmp\/[\w\-./]+\.(?:png|jpg|jpeg|gif|webp)/gi);
  return matches ? [...new Set(matches)] : [];
}

function extractModelName(text) {
  const modelMatch = text.match(/\[(NVIDIA[^\]]*|Imagen[^\]]*|Freepik[^\]]*|Runware[^\]]*|Replicate[^\]]*)\]/);
  if (modelMatch && modelMatch[1]) return modelMatch[1];
  if (text.includes("NVIDIA Flux")) return "NVIDIA Flux";
  if (text.includes("NVIDIA SD3.5")) return "NVIDIA SD3.5";
  if (text.includes("NVIDIA SD3")) return "NVIDIA SD3";
  if (text.includes("Imagen 4")) return "Imagen 4 Fast";
  if (text.includes("Runware")) return "Runware";
  if (text.includes("Freepik")) return "Freepik";
  return "Image Generation";
}

function isCommandAttempt(text) {
  return COMMAND_PATTERNS.some((p) => p.test(text));
}

function isZTurboIntent(rawText) {
  const explicit = /z.?turbo|zimage/i.test(rawText) && rawText.length < 300;
  const imperative = /^\s*(generate|make|create|draw|render|produce|paint|design|can you|could you|please)\b/i.test(rawText)
    && /\b(image|photo|picture|pic|visual|artwork|illustration|portrait|scene|poster|wallpaper|banner)\b/i.test(rawText);
  return { intent: explicit || imperative, explicit, imperative };
}

function shouldFallbackImagePath(responseText) {
  return /generate_image\.py|imagen.*generat|\[ZTURBO|\[COMFYUI/i.test(responseText);
}

function contentDedupKey(userId, content) {
  return `${userId}:${(content || "").replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase()}`;
}

function isCriticalFeedback(text) {
  if (!text || text.length < 15) return false;
  if (/\b(solid|checks out|correct|nailed it|well done|good call|accurate|on point|fair enough|nice)\b/i.test(text)) return false;
  return /\b(sidestep|missed|ignor|overconfiden|gap|chased|forgot|skipped|dodg|deflect|fabricat|hallucin|wrong|incorrect|didn.t answer|failed to|left out|gloss|vague|shallow|lazy|off.?base|didn.t address|dropped|overlook|mislead|unfounded|baseless|nonsense)/i.test(text);
}

function isCreativeTask(message) {
  return /\b(webnovel|story|stories|write.*novel|novel.*write|write.*chapter|write.*fiction|write.*narrative|caption.*gallery|gallery.*caption|write.*post|post.*website|atelier|netify.*post)\b/i.test(message);
}

function shouldFireCrewReactions(userMessage, pipesResponse) {
  if (!pipesResponse || pipesResponse.length < 80) return false;
  const generative = /\b(generat|render|creat|compos|design|draw|edit|capcut|zturbo|comfyui|video|image|photo|gif|music|song|post.*ig|instagram|gallery|netify|site.edit)\b/i;
  if (generative.test(userMessage) || generative.test(pipesResponse)) return true;
  if (isCreativeTask(userMessage)) return true;
  if (/\b(caption|aesthetic|vibe|style|mood|brand|content|viral|trend|hook|title|cover)\b/i.test(userMessage)) return true;
  if (/\b(transcript|youtube\.com|youtu\.be|batch_transcript|search|lookup|what is|who is|when did|how does|explain|summarize|analyze channel|how many|list|show me)\b/i.test(userMessage)) return false;
  if (userMessage.length < 25) return false;
  return true;
}

function shouldGetCrewInput(message) {
  if (!message || message.length < 15) return false;
  // Skip factual lookups — crew input not useful
  if (/\b(transcript|youtube\.com|youtu\.be|what is|who is|when did|how does|explain|search)\b/i.test(message)) return false;
  // Skip very simple commands (single slash commands with no creative decision)
  if (/^\/(?:help|model|queue)\b/i.test(message)) return false;
  // Always consult on creative writing
  if (isCreativeTask(message)) return true;
  // Always consult when user explicitly invokes the crew
  if (/\b(crew|swarm|hey crew|hey swarm|assemble|team|huddle)\b/i.test(message)) return true;
  // Music/song — crew input on lyrics, style, mood
  if (/\b(song|music|sing|suno|ace.?step|lyrics|beat|melody|track)\b/i.test(message)) return true;
  // Image/video generation — crew input on creative direction
  if (/\b(generate|make|create|draw|render|imagine)\b.{0,40}\b(image|video|photo|picture|gif|art)\b/i.test(message)) return true;
  // Planning, strategy, decisions
  if (/\b(what.*work on|next.*list|priority|plan|strategy|idea|suggest|decision|direction|collab)\b/i.test(message)) return true;
  // Aesthetic/creative discussions
  if (/\b(caption|aesthetic|vibe|style|mood|brand|content|viral|trend|hook|title|cover)\b/i.test(message)) return true;
  // Social media posting decisions
  if (/\b(post.*ig|post.*instagram|post.*social|share|publish)\b/i.test(message)) return true;
  // Longer messages likely need crew perspective (>60 chars, not a simple command)
  if (message.length > 60 && !/^\//.test(message)) return true;
  return false;
}

module.exports = {
  stripCommands,
  extractImagePaths,
  extractModelName,
  isCommandAttempt,
  isZTurboIntent,
  shouldFallbackImagePath,
  contentDedupKey,
  isCriticalFeedback,
  isCreativeTask,
  shouldFireCrewReactions,
  shouldGetCrewInput,
  COMMAND_PATTERNS,
};
