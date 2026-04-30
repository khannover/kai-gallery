const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const redis = new Redis({ host: 'redis' });
let musicMetadataModulePromise;
const MEDIA_DIR = path.join(__dirname, 'public', 'media');
const VOTER_COOKIE = 'kai_gallery_voter';
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.mp3',
  '.wav',
  '.ogg'
]);

const storage = multer.diskStorage({
  destination: './public/media/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((cookies, part) => {
    const [rawKey, ...valueParts] = part.trim().split('=');
    if (!rawKey) return cookies;
    cookies[rawKey] = decodeURIComponent(valueParts.join('='));
    return cookies;
  }, {});
}

function createVoterId() {
  return crypto.randomUUID();
}

function ensureVoterId(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  let voterId = cookies[VOTER_COOKIE];

  if (!voterId) {
    voterId = createVoterId();
    res.setHeader(
      'Set-Cookie',
      `${VOTER_COOKIE}=${encodeURIComponent(voterId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
    );
  }

  req.voterId = voterId;
  next();
}

function isSupportedMedia(fileName) {
  return SUPPORTED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function getVoteCountKey(item) {
  return `vote:count:${item}`;
}

function getVoteVotersKey(item) {
  return `vote:voters:${item}`;
}

function getUserVotesKey(voterId) {
  return `vote:user:${voterId}`;
}

function getMediaType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.mp4') return 'video';
  if (extension === '.mp3' || extension === '.wav' || extension === '.ogg') return 'audio';
  return 'image';
}

async function getParseFile() {
  if (!musicMetadataModulePromise) {
    musicMetadataModulePromise = import('music-metadata');
  }

  const musicMetadata = await musicMetadataModulePromise;
  return musicMetadata.parseFile;
}

function normalizeArtworkMime(format = '') {
  const normalizedFormat = String(format).trim().toLowerCase();
  if (!normalizedFormat) return 'image/jpeg';
  if (normalizedFormat.includes('/')) return normalizedFormat;
  if (normalizedFormat === 'jpg') return 'image/jpeg';
  return `image/${normalizedFormat}`;
}

async function getMediaMetadata(fileName) {
  const type = getMediaType(fileName);
  const baseMetadata = {
    file: fileName,
    type,
    title: path.parse(fileName).name,
    artist: '',
    artwork: null
  };

  if (type !== 'audio' || path.extname(fileName).toLowerCase() !== '.mp3') {
    return baseMetadata;
  }

  try {
    const parseFile = await getParseFile();
    const metadata = await parseFile(path.join(MEDIA_DIR, fileName));
    const picture = metadata.common.picture?.[0];
    return {
      ...baseMetadata,
      title: metadata.common.title || baseMetadata.title,
      artist: metadata.common.artist || '',
      artwork: picture
        ? `data:${normalizeArtworkMime(picture.format)};base64,${Buffer.from(picture.data).toString('base64')}`
        : null
    };
  } catch (error) {
    console.error(`Could not read metadata for ${fileName}:`, error.message);
    return baseMetadata;
  }
}

function listMediaFiles() {
  if (!fs.existsSync(MEDIA_DIR)) return [];
  return fs
    .readdirSync(MEDIA_DIR)
    .filter(file => !file.startsWith('.') && isSupportedMedia(file))
    .sort((left, right) => left.localeCompare(right));
}

app.use(ensureVoterId);
app.use(express.static('public'));
app.use(express.json());

app.get('/api/media', (req, res) => {
  res.json(listMediaFiles());
});

app.get('/api/media-metadata', async (req, res) => {
  const files = listMediaFiles();
  const metadataEntries = await Promise.all(files.map(async file => [file, await getMediaMetadata(file)]));
  res.json(Object.fromEntries(metadataEntries));
});

app.get('/api/votes', async (req, res) => {
  const keys = await redis.keys('vote:count:*');
  const votes = {};
  for (let key of keys) {
    votes[key.replace('vote:count:', '')] = Number(await redis.get(key) || 0);
  }
  res.json(votes);
});

app.get('/api/my-votes', async (req, res) => {
  const items = await redis.smembers(getUserVotesKey(req.voterId));
  res.json(items);
});

io.on('connection', (socket) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  socket.data.voterId = cookies[VOTER_COOKIE] || createVoterId();

  function normalizeVoteItem(item) {
    const normalizedItem = path.basename(String(item || ''));
    const mediaPath = path.join(MEDIA_DIR, normalizedItem);

    if (!normalizedItem || !isSupportedMedia(normalizedItem) || !fs.existsSync(mediaPath)) {
      return null;
    }

    return normalizedItem;
  }

  socket.on('cast-vote', async (item, callback) => {
    const acknowledge = typeof callback === 'function' ? callback : () => {};
    const normalizedItem = normalizeVoteItem(item);

    if (!normalizedItem) {
      acknowledge({ ok: false, reason: 'invalid-item' });
      return;
    }

    const voterId = socket.data.voterId;
    const isNewVote = await redis.sadd(getVoteVotersKey(normalizedItem), voterId);
    if (!isNewVote) {
      const count = Number(await redis.get(getVoteCountKey(normalizedItem)) || 0);
      acknowledge({ ok: false, reason: 'duplicate-vote', item: normalizedItem, count });
      return;
    }

    const results = await redis
      .multi()
      .incr(getVoteCountKey(normalizedItem))
      .sadd(getUserVotesKey(voterId), normalizedItem)
      .exec();

    const newVal = Number(results?.[0]?.[1] || 0);
    acknowledge({ ok: true, item: normalizedItem, count: newVal });
    io.emit('vote-announcement', { item: normalizedItem, count: newVal });
  });

  socket.on('remove-vote', async (item, callback) => {
    const acknowledge = typeof callback === 'function' ? callback : () => {};
    const normalizedItem = normalizeVoteItem(item);

    if (!normalizedItem) {
      acknowledge({ ok: false, reason: 'invalid-item' });
      return;
    }

    const voterId = socket.data.voterId;
    const removedVote = await redis.srem(getVoteVotersKey(normalizedItem), voterId);
    if (!removedVote) {
      const count = Number(await redis.get(getVoteCountKey(normalizedItem)) || 0);
      acknowledge({ ok: false, reason: 'vote-not-found', item: normalizedItem, count });
      return;
    }

    const results = await redis
      .multi()
      .decr(getVoteCountKey(normalizedItem))
      .srem(getUserVotesKey(voterId), normalizedItem)
      .exec();

    const newVal = Math.max(0, Number(results?.[0]?.[1] || 0));
    if (newVal === 0) {
      await redis.del(getVoteCountKey(normalizedItem));
    }

    acknowledge({ ok: true, item: normalizedItem, count: newVal });
    io.emit('vote-announcement', { item: normalizedItem, count: newVal });
  });
});

server.listen(3000, () => console.log('Galerie laeuft!'));
