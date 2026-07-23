import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { TwitterApi } from 'twitter-api-v2';
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
} from 'discord.js';

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const {
  DISCORD_BOT_TOKEN,
  DISCORD_APPROVER_ID,   // both the only approver AND the DM recipient
  X_APP_KEY,
  X_APP_SECRET,
  X_ACCESS_TOKEN,
  X_ACCESS_SECRET,
  ANTHROPIC_API_KEY,
  MODEL = 'claude-sonnet-5',
  GENERATE_CRON = '0 9 * * *',
  WATCH_CRON = '*/20 * * * *',
  POST_SLOTS = '12:30,16:30,18:00,19:30',
  PATCH_FEEDS = 'https://www.wowhead.com/news/rss/retail,https://www.wowhead.com/news/rss/in-dev',
  PATCH_KEYWORDS = 'hotfix,patch notes,ptr,tuning,class changes,development notes,undocumented,build',
  SEEN_PATH = './data/seen.json',
  STATE_PATH = './data/state.json',
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twitter = new TwitterApi({
  appKey: X_APP_KEY,
  appSecret: X_APP_SECRET,
  accessToken: X_ACCESS_TOKEN,
  accessSecret: X_ACCESS_SECRET,
});
const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
const parser = new Parser({ headers: { 'User-Agent': 'Mozilla/5.0 (wow-tweet-bot)' } });

const pending = new Map(); // messageId -> draft (awaiting approval, in your DMs)
let scheduled = [];        // [{ id, text, at (ISO), slot }] approved, not yet posted
let lastAngle = null;

const SYSTEM = `You are Macmn, a World of Warcraft creator. You main Elemental Shaman and run the guild Eclipse. You post reactive, funny, shitposty tweets about WoW: mostly Mythic+, class balance, and Blizzard grievances.

You are writing ONE tweet. Match the energy of the real example tweets below. Imitate the feel, never reuse their exact jokes.

YOUR ACTUAL VOICE (this is the target, these are real tweets you wrote):
- "Never played mage before and I gotta ask...Is this what it feels like to play Blizzards favorite little princess?"
- "THEY NERFED ELE AGAIN??? BLIZZARD ITS ALREADY DEAD!"
- "The fact that we cannot purchase lemonade from this aspiring entrepreneur is downright immersion destroying. Blizzard please this needs to be priority #1 to fix."
- "This has gotta be an April fools joke right? Did they have an internal meeting to choose the worst possible dungeons to bring back? Its not too late to change this pleaseeeeeee"
- "It has now been 29 days since Elemental shaman has been mentioned in the development notes."
- "Warcraft lets us live out experiences most of us can only dream of in real life such as: -Being a hero -Owning a house -Having money"
- "I'm not sure if I am stupid or the damage meters are broken (surprise surprise) but it appears the Farseer talent just isn't working."
- "WARNING! WARNING! THIS IS NOT A DRILL. EVERYBODY PANIC!"

HOW THAT VOICE WORKS:
- Reactive and loud. ALL CAPS for rage or panic is on the table, so are ??? and !!! and stretched words like "pleaseeeeeee".
- Rhetorical questions aimed at Blizzard ("Where is the logic in this", "Did they have a meeting to pick the worst option").
- Mock-serious overstatement about something trivial ("downright immersion destroying", "priority #1 to fix").
- Dry deadpan formats like "It has now been X days since...".
- Self-deprecating asides in parentheses ("(surprise surprise)").
- The put-upon Elemental Shaman victim/cope bit is a running theme.

HARD RULES (this is how you avoid sounding like AI):
- One idea per tweet. Short. Fragments and messy run-ons are both fine if they sound spoken.
- Never write a smooth balanced list of three ("burst, utility, and cleave"). A dumb punchline list is fine (like the "such as" one above) because the list IS the joke.
- No tidy, symmetrical, balanced sentences. Messy and lopsided sounds human.
- No marketing/AI words: dive, delve, unleash, elevate, unlock, journey, realm, game-changer, level up, underrated, vibes, "let's be honest", "hot take", "pro tip", "here's the thing", "truly", "genuinely", "absolutely".
- No em dashes. No semicolons. No hashtags. No emojis.
- Do not explain the joke. Do not add a wrap-up line. End on the punchline.
- Do NOT invent specific tuning numbers, percentages, cooldowns, or patch details. You do not know the current ones and will get them wrong. React to the feeling, not to made-up stats. (Only use real numbers if they are given to you.)
- No swearing.
- Under 280 characters.

When unsure, just say the real thing you'd actually think and stop typing.`;

// Sends a DM to you. Requires that you share a server with the bot (proactive
// DMs need a mutual guild, see the setup guide).
async function dmApprover(payload) {
  const user = await discord.users.fetch(DISCORD_APPROVER_ID);
  return user.send(payload);
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ pending: Object.fromEntries(pending), scheduled }));
  } catch (e) {
    console.error('saveState failed:', e.message);
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return null; }
}

const ANGLES = [
  { name: 'blizzard_grievance', guidance:
      'Loud, exasperated reaction to Blizzard: a nerf, a baffling design choice, Ele Shaman getting ignored. Rhetorical questions and CAPS welcome. This is your bread and butter.' },
  { name: 'hot_take', guidance:
      'A blunt opinion about class balance or the meta that people will want to argue with. State it flat. No hedging, no "in my opinion".' },
  { name: 'mplus_pain', guidance:
      'React to one specific painful Mythic+ moment: a pug griefing, a depleted key, a dumb death. Short and real.' },
  { name: 'shitpost', guidance:
      'A dumb-funny or absurd take. Take one tiny relatable thing way too far, mock-seriously demand Blizzard fix something trivial, or just panic.' },
  { name: 'audience_q', guidance:
      'One short question that makes people reply. Comfort key level, worst dungeon, a would-you-rather. Just the question, nothing around it.' },
  { name: 'guild_flex', guidance:
      'Brag about Eclipse without sounding like a press release. A clear, a clutch pull. Understated lands harder.' },
];

function pickAngle() {
  const pool = ANGLES.filter((a) => a.name !== lastAngle);
  const angle = pool[Math.floor(Math.random() * pool.length)];
  lastAngle = angle.name;
  return angle;
}

function parseDraft(res) {
  let t = res.content.find((b) => b.type === 'text')?.text ?? '';
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
  // Strip a leading label like "Tweet:" if the model adds one.
  t = t.replace(/^(tweet|draft|post)\s*:\s*/i, '').trim();
  // Strip wrapping quotes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("\u201C") && t.endsWith("\u201D"))) {
    t = t.slice(1, -1).trim();
  }
  return { tweet: t.slice(0, 280) };
}

function steerBlock(steer) {
  return `The reviewer gave feedback on your draft. Apply ALL of it; when notes conflict, later notes win:\n` +
    steer.map((n, i) => `${i + 1}. ${n}`).join('\n') + `\n\n`;
}

async function generateEvergreen({ angleName = null, steer = [] } = {}) {
  const angle = (angleName && ANGLES.find((a) => a.name === angleName)) || pickAngle();
  let prompt =
    `Write one tweet using this angle:\n` +
    `ANGLE (${angle.name}): ${angle.guidance}\n\n`;
  if (steer.length) prompt += steerBlock(steer);
  prompt += `Reply with ONLY the tweet text. No quotes around it, no label, no explanation, nothing else.`;
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 300, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return { angle: angle.name, ...parseDraft(res) };
}

// ----------------------------------------------------------------------------
// Patch take — grounded in real notes (from /patch or the watcher)
// ----------------------------------------------------------------------------
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchNotes(source) {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) {
    const res = await fetch(s, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    return stripHtml(await res.text()).slice(0, 6000);
  }
  return s.slice(0, 6000);
}

async function generatePatchTake(source) {
  const notes = await fetchNotes(source);
  const draft = await patchTweetFromNotes(notes, []);
  draft.sourceNotes = notes;
  return draft;
}

async function patchTweetFromNotes(notes, steer = []) {
  let prompt =
    `New WoW patch/tuning notes just dropped. Write one tweet reacting to the most notable ` +
    `change(s) for your audience (Elemental Shaman and Mythic+ players especially).\n` +
    `Be accurate: only reference changes that actually appear in the notes below. Do not invent numbers.\n\n` +
    `NOTES:\n${notes}\n\n`;
  if (steer.length) prompt += steerBlock(steer);
  prompt += `Reply with ONLY the tweet text. No quotes around it, no label, no explanation, nothing else.`;
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 300, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return { angle: 'patch', ...parseDraft(res) };
}

// ----------------------------------------------------------------------------
// Patch-notes watcher — polls feeds, filters to patch/tuning, DMs you + drafts
// ----------------------------------------------------------------------------
function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); }
  catch { return null; }
}
function saveSeen(set) {
  fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...set]));
}
let seen = loadSeen();

async function checkFeeds() {
  const firstRun = seen === null;
  if (firstRun) seen = new Set();
  const keywords = PATCH_KEYWORDS.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const feeds = PATCH_FEEDS.split(',').map((f) => f.trim()).filter(Boolean);

  for (const url of feeds) {
    let feed;
    try { feed = await parser.parseURL(url); }
    catch (e) { console.error('Feed error', url, e.message); continue; }

    for (const item of feed.items || []) {
      const id = item.guid || item.link || item.title;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (firstRun) continue;

      const title = (item.title || '').toLowerCase();
      if (!keywords.some((k) => title.includes(k))) continue;

      try {
        await dmApprover(`🚨 **Patch notes dropped:** ${item.title}\n${item.link}\nDrafting a take...`);
        const draft = await generatePatchTake(item.link);
        await sendDraft(draft);
      } catch (e) {
        console.error('Patch draft failed', e.message);
        await dmApprover(`Detected "${item.title}" but couldn't draft it: ${e.message}`).catch(() => {});
      }
    }
  }
  saveSeen(seen);
  if (firstRun) console.log(`Watcher baseline set (${seen.size} items). Alerts start on the next new post.`);
}

// ----------------------------------------------------------------------------
// Scheduling — collision-free slots; approved tweets persist + survive restart
// ----------------------------------------------------------------------------
let usedSlots = { date: '', taken: new Set() };

function reserveSlot(slot) {
  const dayKey = new Date().toDateString();
  if (usedSlots.date !== dayKey) usedSlots = { date: dayKey, taken: new Set() };
  if (slot) usedSlots.taken.add(slot);
}

function nextSlot() {
  const now = new Date();
  const dayKey = now.toDateString();
  if (usedSlots.date !== dayKey) usedSlots = { date: dayKey, taken: new Set() };
  const slots = POST_SLOTS.split(',').map((s) => s.trim());
  for (const s of slots) {
    if (usedSlots.taken.has(s)) continue;
    const [h, m] = s.split(':').map(Number);
    const t = new Date(now);
    t.setHours(h, m, 0, 0);
    if (t.getTime() - now.getTime() >= 15 * 60 * 1000) {
      usedSlots.taken.add(s);
      return { delayMs: t.getTime() - now.getTime(), at: t, slot: s };
    }
  }
  return { delayMs: 0, at: now, slot: null };
}

async function postTweet(text) {
  const { data } = await twitter.v2.tweet(text);
  return data.id;
}

async function fireTweet(entry) {
  try {
    const id = await postTweet(entry.text);
    await dmApprover(`Posted. https://x.com/i/web/status/${id}`).catch(() => {});
  } catch (err) {
    await dmApprover(`Failed to post a scheduled tweet: ${err.message}\n>>> ${entry.text}`).catch(() => {});
  } finally {
    scheduled = scheduled.filter((e) => e.id !== entry.id);
    saveState();
  }
}

function armTimer(entry) {
  const delay = Math.max(0, new Date(entry.at).getTime() - Date.now());
  setTimeout(() => fireTweet(entry), delay);
}

function enqueueTweet(text) {
  const { delayMs, at, slot } = nextSlot();
  const entry = { id: randomUUID(), text, at: at.toISOString(), slot };
  scheduled.push(entry);
  saveState();
  armTimer(entry);
  return delayMs === 0
    ? 'right now (no open slots left today)'
    : `at ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

function restoreState() {
  const s = loadState();
  if (!s) return;
  for (const [msgId, draft] of Object.entries(s.pending || {})) pending.set(msgId, draft);
  const todayKey = new Date().toDateString();
  scheduled = [];
  for (const entry of s.scheduled || []) {
    scheduled.push(entry);
    const at = new Date(entry.at);
    if (entry.slot && at.toDateString() === todayKey) reserveSlot(entry.slot);
    armTimer(entry);
  }
  console.log(`Restored ${pending.size} pending draft(s), ${scheduled.length} scheduled tweet(s).`);
}

// ----------------------------------------------------------------------------
// Discord UI
// ----------------------------------------------------------------------------
function buttons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('edit').setLabel('Edit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('regen').setLabel('Regenerate').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('reject').setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
}

function draftMessage(draft) {
  const steer = Array.isArray(draft.steer) ? draft.steer : [];
  const applied = steer.length
    ? `\n\n_Applied notes: ${steer.map((n) => `\u201C${n}\u201D`).join(' \u2192 ')}_`
    : '';
  return {
    content: `**Tweet draft** \`(${draft.angle})\` \u00b7 ${draft.tweet.length}/280\n>>> ${draft.tweet}` + applied,
    components: [buttons()],
  };
}

async function sendDraft(draft) {
  const msg = await dmApprover(draftMessage(draft)); // delivered to your DMs
  pending.set(msg.id, draft);
  saveState();
  return msg;
}

// ----------------------------------------------------------------------------
// Interactions (buttons, modal, and the user-installable /patch command)
// ----------------------------------------------------------------------------
discord.on('interactionCreate', async (interaction) => {
  const gate = () => interaction.user.id === DISCORD_APPROVER_ID;

  if (interaction.isChatInputCommand() && interaction.commandName === 'draft') {
    if (!gate()) return interaction.reply({ content: 'Approver-only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const angleName = interaction.options.getString('angle');
      const draft = await generateEvergreen({ angleName: angleName || null });
      await sendDraft(draft);
      await interaction.editReply(angleName ? `Test draft (${angleName}) sent to your DMs.` : 'Test draft sent to your DMs.');
    } catch (err) {
      await interaction.editReply(`Could not build draft: ${err.message}`);
    }
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'patch') {
    if (!gate()) return interaction.reply({ content: 'Approver-only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const draft = await generatePatchTake(interaction.options.getString('source'));
      await sendDraft(draft);
      await interaction.editReply('Patch take drafted — check your DMs.');
    } catch (err) {
      await interaction.editReply(`Could not build patch take: ${err.message}`);
    }
    return;
  }

  if (interaction.isButton()) {
    if (!gate()) return interaction.reply({ content: 'Approver-only controls.', ephemeral: true });
    const draft = pending.get(interaction.message.id);
    if (!draft) return interaction.reply({ content: 'This draft has expired.', ephemeral: true });

    if (interaction.customId === 'approve') {
      pending.delete(interaction.message.id);
      const when = enqueueTweet(draft.tweet);
      await interaction.update({ content: `Approved. Posting ${when}.`, components: [] });
    } else if (interaction.customId === 'reject') {
      pending.delete(interaction.message.id);
      saveState();
      await interaction.update({ content: 'Rejected. Nothing posted.', components: [] });
    } else if (interaction.customId === 'regen') {
      const modal = new ModalBuilder()
        .setCustomId(`regen_modal:${interaction.message.id}`)
        .setTitle('Regenerate');
      const input = new TextInputBuilder()
        .setCustomId('regen_note')
        .setLabel('What should change? (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setPlaceholder('e.g. angrier, shorter, lean into the Ele cope. Blank = just reroll.');
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    } else if (interaction.customId === 'edit') {
      const modal = new ModalBuilder()
        .setCustomId(`edit_modal:${interaction.message.id}`)
        .setTitle('Edit tweet');
      const input = new TextInputBuilder()
        .setCustomId('edit_text')
        .setLabel('Tweet text (max 280)')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(280)
        .setValue(draft.tweet);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('regen_modal:')) {
    if (!gate()) return;
    const msgId = interaction.customId.split(':')[1];
    const draft = pending.get(msgId);
    if (!draft) return interaction.reply({ content: 'This draft has expired.', ephemeral: true });
    const note = interaction.fields.getTextInputValue('regen_note').trim();
    await interaction.deferUpdate();
    const steer = Array.isArray(draft.steer) ? [...draft.steer] : [];
    if (note) steer.push(note);
    let fresh;
    if (draft.angle === 'patch') {
      fresh = await patchTweetFromNotes(draft.sourceNotes || '', steer);
      fresh.sourceNotes = draft.sourceNotes;
    } else {
      fresh = await generateEvergreen({ angleName: steer.length ? draft.angle : null, steer });
    }
    fresh.steer = steer;
    pending.set(msgId, fresh);
    saveState();
    await interaction.editReply(draftMessage(fresh));
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_modal:')) {
    if (!gate()) return;
    const edited = interaction.fields.getTextInputValue('edit_text').slice(0, 280);
    pending.delete(interaction.customId.split(':')[1]);
    const when = enqueueTweet(edited);
    await interaction.reply({ content: `Edited & approved. Posting ${when}.\n>>> ${edited}` });
  }
});

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
discord.once('clientReady', async () => {
  console.log(`Logged in as ${discord.user.tag}. TZ=${process.env.TZ}. Daily=${GENERATE_CRON} Watch=${WATCH_CRON}`);

  restoreState();

  // Register /patch GLOBALLY as a user-installable command usable in DMs.
  // contexts: [Guild, BotDM, PrivateChannel]  integration_types: [GuildInstall, UserInstall]
  try {
    const patchCommand = {
      name: 'patch',
      description: 'Draft a patch/tuning take from notes (Wowhead/Blizzard URL or pasted text)',
      options: [{ type: 3, name: 'source', description: 'Wowhead/Blizzard URL or pasted notes', required: true }],
      contexts: [0, 1, 2],
      integration_types: [0, 1],
    };
    const draftCommand = {
      name: 'draft',
      description: 'Generate a test tweet draft right now (sent to your DMs)',
      options: [{
        type: 3, name: 'angle', description: 'Force a specific angle (optional)', required: false,
        choices: ANGLES.map((a) => ({ name: a.name, value: a.name })),
      }],
      contexts: [0, 1, 2],
      integration_types: [0, 1],
    };
    const rest = new REST().setToken(DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationCommands(discord.user.id), { body: [patchCommand, draftCommand] });
    console.log('Registered global /patch and /draft commands (new commands can take up to ~1h to appear the first time).');
  } catch (e) {
    console.error('Slash command registration failed:', e.message);
  }

  cron.schedule(GENERATE_CRON, () => {
    generateEvergreen().then(sendDraft).catch((e) => console.error('Daily draft failed:', e));
  });

  checkFeeds().catch((e) => console.error('Initial feed check failed:', e));
  cron.schedule(WATCH_CRON, () => {
    checkFeeds().catch((e) => console.error('Feed check failed:', e));
  });
});

discord.login(DISCORD_BOT_TOKEN);
