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

const SYSTEM = `You are Macmn. You main Elemental Shaman and you run the guild Eclipse. You post reactive, funny, self deprecating tweets about WoW: Mythic+, class balance, Blizzard grievances, and the misery of making videos.

Write ONE tweet. Copy the voice below. Never reuse these exact jokes, just the feel.

REAL TWEETS YOU WROTE (this is the target):
- Never played mage before and I gotta ask...Is this what it feels like to play Blizzards favorite little princess?
- THEY NERFED ELE AGAIN??? BLIZZARD ITS ALREADY DEAD!
- The fact that we cannot purchase lemonade from this aspiring entrepreneur is downright immersion destroying. Blizzard please this needs to be priority #1 to fix.
- This has gotta be an April fools joke right? Did they have an internal meeting to choose the worst possible dungeons to bring back? Its not too late to change this pleaseeeeeee
- It has now been 29 days since Elemental shaman has been mentioned in development notes.
- Warcraft lets us live out experiences most of us can only dream of in real life such as: -Being a hero -Owning a house -Having money
- I'm not sure if I am stupid or the damage meters are broken (surprise surprise) but it appears the Farseer talent isnt working.
- WARNING! WARNING! THIS IS NOT A DRILL. EVERYBODY PANIC!
- I just had a great 2 hour recording session. Only problem was when I went to start editing and was told all the footage was corruped...Im going to bed...
- After my corrupted footage I re-recorded everything. I now have 2 hours of raw footage to cut and edit. This is the largest video I have attempted to make...Wish me luck...
- Guys! I did it! My mom is finally proud of me!
- Unironically, can anyone teach me how to Twitter.
- Can we go ONE WEEK without drama PLEASE???
- Completley hypothetically, wouldnt it be funny if I gave out Chonky d20s to the first few people to find me and say nothing but the word Banana.
- One of my favorite things to do is sprinkle in degenerate content like this into my videos. I cannot say I am proud of myself.

HOW YOU TYPE:
- Trailing "..." is your signature move for a deadpan or defeated ending. Use it in roughly one out of three tweets, not every one. Sometimes you open with it too.
- Drop apostrophes often: Its, Im, thats, dont, wouldnt, cant, isnt. Not every single time. Never fix them.
- CAPS mid sentence for emphasis. Full caps when raging OR when hyped, both sound the same from you.
- Stacked punctuation when worked up: ??? and !!!
- Stretch words when begging: pleaseeeeeee
- Excitement is short exclamation bursts. "Guys! I did it!"
- Mock formal openers when being funny: "Unironically," / "Completley hypothetically," / "Needless to say,"
- "lol" is the only internet slang you use. Never lmao, bro, ngl, fr.
- Basically never use emojis.
- Sometimes speak for Ele players as "we" and "us".
- No hashtags. No em dashes. No semicolons.

STRUCTURES YOU USE:
- Setup then resigned punchline. A longer sentence about something going wrong, then a short defeated ending.
- Rhetorical questions aimed at Blizzard. "Where is the logic in this" / "Did they have a meeting to pick the worst option"
- Deadpan counter. "It has now been X days since..."
- Self deprecating aside in parentheses. "(surprise surprise)"
- Mock serious overstatement about something trivial. "downright immersion destroying" / "priority #1 to fix"
- A punchline list where the list IS the joke.
- Occasionally sincere and warm about the community, especially against toxicity.

NEVER (this is what makes it sound like AI):
- No smooth balanced list of three. No tidy symmetrical sentences.
- No marketing words: dive, delve, unleash, elevate, unlock, journey, realm, game changer, level up, underrated, vibes, "lets be honest", "hot take", "pro tip", "heres the thing", "truly", "genuinely", "absolutely".
- Never explain the joke and never add a wrap up line. End on the punchline.
- Never invent specific tuning numbers, percentages, cooldowns, or patch details. You will get them wrong. React to the feeling instead. Only use real numbers if they are given to you.
- Some of the real tweets above were captions on a screenshot. You are writing text only, so never reference an image or "this picture".
- No swearing.
- Under 280 characters.`;

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
  { name: 'news_reaction', guidance:
      'React to something that actually happened in WoW recently. Pick the single most reaction-worthy item from the list you are given and respond to it the way you actually would. Do not summarize it like a news anchor.' },
  { name: 'blizzard_grievance', guidance:
      'Loud exasperated reaction to Blizzard: a nerf, a baffling design choice, Ele getting ignored again. CAPS and rhetorical questions welcome. Your bread and butter.' },
  { name: 'hot_take', guidance:
      'A blunt opinion about class balance or the meta that people will want to argue with. State it flat, no hedging.' },
  { name: 'mplus_pain', guidance:
      'One specific painful Mythic+ moment: a pug griefing, a depleted key, a dumb death. Setup then resigned punchline works great here.' },
  { name: 'shitpost', guidance:
      'Dumb funny or absurd. Take a tiny relatable thing way too far, mock seriously demand Blizzard fix something trivial, or just panic.' },
  { name: 'creator_life', guidance:
      'The misery or small wins of making WoW videos: editing, recording, footage problems, a milestone. Self deprecating.' },
  { name: 'audience_q', guidance:
      'One short question that makes people reply. Comfort key level, worst dungeon, a would you rather. Just the question.' },
  { name: 'guild_flex', guidance:
      'Eclipse did something good. A clear, a clutch pull. You get hyped in caps, not in a press release.' },
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

async function generateEvergreen({ angleName = null, steer = [], topic = null, link = null } = {}) {
  const angle = (angleName && ANGLES.find((a) => a.name === angleName)) || pickAngle();
  let prompt = topic
    ? `Write one tweet about this specific topic:\nTOPIC: ${topic}\n\n` +
      `Use this tone/angle: ${angle.guidance}\n\n`
    : `Write one tweet using this angle:\n` +
      `ANGLE (${angle.name}): ${angle.guidance}\n\n`;

  // Ground timely tweets in real, recent headlines so nothing gets invented.
  if (!topic && angle.name === 'news_reaction') {
    const items = await fetchRecentItems();
    if (!items.length) return generateEvergreen({ angleName: 'blizzard_grievance', steer });
    prompt += `Recent WoW headlines (pick ONE and react to it, only use facts present here):\n` +
      items.map((i, n) => `${n + 1}. ${i.title}`).join('\n') + `\n\n`;
  }
  if (link) prompt += `A link will be added to the end of this tweet, so keep the text under 240 characters and do not write out any URL yourself.\n\n`;
  if (steer.length) prompt += steerBlock(steer);
  prompt += `Reply with ONLY the tweet text. No quotes around it, no label, no explanation, nothing else.`;
  const res = await anthropic.messages.create({
    model: MODEL, max_tokens: 300, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return { angle: angle.name, topic: topic || null, link: link || null, ...parseDraft(res) };
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
// ----------------------------------------------------------------------------
// Recent WoW happenings (used for timely tweets and the /topics command)
// ----------------------------------------------------------------------------
async function fetchRecentItems(limit = 12, days = 7) {
  const feeds = PATCH_FEEDS.split(',').map((f) => f.trim()).filter(Boolean);
  const cutoff = Date.now() - days * 86400000;
  const items = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const it of feed.items || []) {
        const raw = it.isoDate || it.pubDate;
        const ts = raw ? Date.parse(raw) : Date.now();
        if (!Number.isNaN(ts) && ts >= cutoff && it.title) {
          items.push({ title: it.title.trim(), link: it.link || '', ts });
        }
      }
    } catch (e) {
      console.error('recent feed error', url, e.message);
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  const seenTitles = new Set();
  return items.filter((i) => !seenTitles.has(i.title) && seenTitles.add(i.title)).slice(0, limit);
}

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

// A link occupies 23 characters on X regardless of its real length.
function composeTweet(draft) {
  return draft.link ? `${draft.tweet} ${draft.link}` : draft.tweet;
}

function displayLength(draft) {
  return draft.tweet.length + (draft.link ? 24 : 0);
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
    content: `**Tweet draft** \`(${draft.angle})\`${draft.topic ? ` \u00b7 topic: ${draft.topic}` : ''} \u00b7 ${displayLength(draft)}/280\n>>> ${composeTweet(draft)}` + applied,
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

  if (interaction.isChatInputCommand() && interaction.commandName === 'topics') {
    if (!gate()) return interaction.reply({ content: 'Approver-only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const items = await fetchRecentItems();
      if (!items.length) return interaction.editReply('No recent items found in the feeds.');
      const lines = items.map((i, n) => `**${n + 1}.** ${i.title}\n<${i.link}>`).join('\n');
      await interaction.editReply(`Recent WoW headlines:\n${lines}`.slice(0, 1900));
    } catch (err) {
      await interaction.editReply(`Could not fetch topics: ${err.message}`);
    }
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'draft') {
    if (!gate()) return interaction.reply({ content: 'Approver-only.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const angleName = interaction.options.getString('angle');
      const topic = interaction.options.getString('topic');
      const link = interaction.options.getString('link');
      const draft = await generateEvergreen({
        angleName: angleName || null, topic: topic || null, link: link || null,
      });
      await sendDraft(draft);
      await interaction.editReply('Test draft sent to your DMs.');
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
      const when = enqueueTweet(composeTweet(draft));
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
        .setLabel('Tweet text')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(280)
        .setValue(draft.tweet);
      const linkInput = new TextInputBuilder()
        .setCustomId('edit_link')
        .setLabel('Link to attach (optional)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(draft.link || '');
      modal.addComponents(
        new ActionRowBuilder().addComponents(input),
        new ActionRowBuilder().addComponents(linkInput),
      );
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
      fresh = await generateEvergreen({
        angleName: (steer.length || draft.topic) ? draft.angle : null,
        steer,
        topic: draft.topic || null,
        link: draft.link || null,
      });
    }
    fresh.steer = steer;
    pending.set(msgId, fresh);
    saveState();
    await interaction.editReply(draftMessage(fresh));
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_modal:')) {
    if (!gate()) return;
    const edited = interaction.fields.getTextInputValue('edit_text').slice(0, 280);
    const editedLink = (interaction.fields.getTextInputValue('edit_link') || '').trim();
    pending.delete(interaction.customId.split(':')[1]);
    const finalText = editedLink ? `${edited} ${editedLink}` : edited;
    const when = enqueueTweet(finalText);
    await interaction.reply({ content: `Edited & approved. Posting ${when}.\n>>> ${finalText}` });
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
      options: [
        { type: 3, name: 'topic', description: 'What should the tweet be about? (optional)', required: false },
        { type: 3, name: 'link', description: 'URL to attach to the tweet (optional)', required: false },
        {
          type: 3, name: 'angle', description: 'Force a specific angle (optional)', required: false,
          choices: ANGLES.map((a) => ({ name: a.name, value: a.name })),
        },
      ],
      contexts: [0, 1, 2],
      integration_types: [0, 1],
    };
    const rest = new REST().setToken(DISCORD_BOT_TOKEN);
    const topicsCommand = {
      name: 'topics',
      description: 'List recent WoW headlines you could tweet about',
      contexts: [0, 1, 2],
      integration_types: [0, 1],
    };
    await rest.put(Routes.applicationCommands(discord.user.id), { body: [patchCommand, draftCommand, topicsCommand] });
    console.log('Registered global /patch, /draft and /topics commands (new commands can take up to ~1h to appear the first time).');
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
