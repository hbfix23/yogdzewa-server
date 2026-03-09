const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const db = admin.firestore();
const app = express();
app.use(express.json({ limit: '100mb' }));

const rateLimitMap = new Map();
function rateLimit(ip, endpoint, maxAttempts, windowMs) {
  const key = `${ip}_${endpoint}`;
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  record.count++;
  rateLimitMap.set(key, record);
  return record.count > maxAttempts;
}

async function tokenDogrula(kozmikToken) {
  const storedHash = process.env.BALPETEGI_HASH;
  const storedSalt = process.env.BALPETEGI_SALT;
  if (!storedHash || !storedSalt || !kozmikToken) return false;
  try {
    const saltBytes = Buffer.from(storedSalt, 'base64');
    const hashBytes = crypto.pbkdf2Sync(kozmikToken, saltBytes, 310000, 64, 'sha512');
    return hashBytes.toString('base64') === storedHash;
  } catch { return false; }
}

app.get('/', (req, res) => {
  res.send('Yogdzewa bildirim sunucusu çalışıyor!');
});

app.post('/ai-chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimit(ip, 'ai-chat', 30, 60 * 1000)) {
    return res.status(429).json({ error: 'Çok fazla istek. Biraz bekle.' });
  }
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Geçersiz mesaj formatı' });
  }
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'AI yapılandırma hatası' });
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Sen Yogdzewa uygulamasının yapay zeka asistanısın. Türkçe konuş. Kısa ve net cevaplar ver.' },
          ...messages
        ],
        max_tokens: 1024,
        temperature: 0.7
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'AI hatası' });
    res.json({ reply: data.choices[0].message.content });
  } catch (e) {
    console.error('AI hata:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/call-notify', async (req, res) => {
  const { calleeUid, callerUsername, callId } = req.body;
  if (!calleeUid || !callerUsername || !callId) {
    return res.status(400).json({ error: 'Eksik bilgi' });
  }
  try {
    const userDoc = await db.collection('users').doc(calleeUid).get();
    const fcmToken = userDoc.data()?.fcmToken;
    if (!fcmToken) return res.status(404).json({ error: 'FCM token bulunamadı' });
    await admin.messaging().send({
      token: fcmToken,
      data: {
        type: 'incoming_call',
        callerUsername: callerUsername,
        callId: callId
      },
      android: {
        priority: 'high',
        ttl: '30000'
      }
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Arama bildirimi hatası:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/upload-media', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimit(ip, 'upload-media', 10, 60 * 1000)) {
    return res.status(429).json({ error: 'Çok fazla istek.' });
  }
  const { uid, base64Data, mediaType, startOffset } = req.body;
  if (!uid || !base64Data || !mediaType) return res.status(400).json({ error: 'Eksik bilgi' });
  if (!['image', 'video'].includes(mediaType)) return res.status(400).json({ error: 'Geçersiz medya tipi' });
  try {
    const offset = parseInt(startOffset) || 0;
    const transformation = mediaType === 'video' ? [{ start_offset: offset, end_offset: offset + 15 }] : [];
    const result = await cloudinary.uploader.upload(base64Data, {
      resource_type: mediaType,
      folder: `yogdzewa/statuses/${uid}`,
      transformation,
      format: mediaType === 'image' ? 'jpg' : 'mp4'
    });
    res.json({ success: true, url: result.secure_url, publicId: result.public_id });
  } catch (e) {
    console.error('Cloudinary yükleme hatası:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/delete-media', async (req, res) => {
  const { uid, publicId } = req.body;
  if (!uid || !publicId) return res.status(400).json({ error: 'Eksik bilgi' });
  try {
    const resourceType = publicId.includes('/video/') ? 'video' : 'image';
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/kozmik-auth', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimit(ip, 'kozmik-auth', 5, 60 * 1000)) {
    return res.status(429).json({ error: 'Çok fazla deneme. 1 dakika bekle.' });
  }
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Eksik bilgi' });
  const KOZMIK_USERNAME = process.env.KOZMIK_USERNAME;
  const KOZMIK_PASSWORD_HASH = process.env.KOZMIK_PASSWORD_HASH;
  const KOZMIK_PASSWORD_SALT = process.env.KOZMIK_PASSWORD_SALT;
  if (!KOZMIK_USERNAME) return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });
  let passwordOk = false;
  if (KOZMIK_PASSWORD_HASH && KOZMIK_PASSWORD_SALT) {
    const saltBytes = Buffer.from(KOZMIK_PASSWORD_SALT, 'base64');
    const hashBytes = crypto.pbkdf2Sync(password, saltBytes, 310000, 64, 'sha512');
    passwordOk = hashBytes.toString('base64') === KOZMIK_PASSWORD_HASH;
  } else {
    passwordOk = password === process.env.KOZMIK_PASSWORD;
  }
  if (username === KOZMIK_USERNAME && passwordOk) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Yetkisiz erişim' });
  }
});

app.post('/balpetegi-auth', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimit(ip, 'balpetegi-auth', 5, 60 * 1000)) {
    return res.status(429).json({ error: 'Çok fazla deneme. 1 dakika bekle.' });
  }
  const { sifre } = req.body;
  if (!sifre) return res.status(400).json({ error: 'Şifre boş' });
  const storedHash = process.env.BALPETEGI_HASH;
  const storedSalt = process.env.BALPETEGI_SALT;
  if (!storedHash || !storedSalt) return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });
  try {
    const saltBytes = Buffer.from(storedSalt, 'base64');
    const hashBytes = crypto.pbkdf2Sync(sifre, saltBytes, 310000, 64, 'sha512');
    if (hashBytes.toString('base64') === storedHash) {
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: 'Yanlış balpeteği' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/balpetegi-degistir', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (rateLimit(ip, 'balpetegi-degistir', 3, 60 * 1000)) {
    return res.status(429).json({ error: 'Çok fazla deneme.' });
  }
  const { eskiSifre, yeniSifre, kozmikToken } = req.body;
  if (!eskiSifre || !yeniSifre || !kozmikToken) return res.status(400).json({ error: 'Eksik bilgi' });
  const KOZMIK_PASSWORD_HASH = process.env.KOZMIK_PASSWORD_HASH;
  const KOZMIK_PASSWORD_SALT = process.env.KOZMIK_PASSWORD_SALT;
  let tokenOk = false;
  if (KOZMIK_PASSWORD_HASH && KOZMIK_PASSWORD_SALT) {
    const saltBytes = Buffer.from(KOZMIK_PASSWORD_SALT, 'base64');
    const hashBytes = crypto.pbkdf2Sync(kozmikToken, saltBytes, 310000, 64, 'sha512');
    tokenOk = hashBytes.toString('base64') === KOZMIK_PASSWORD_HASH;
  } else {
    tokenOk = kozmikToken === process.env.KOZMIK_PASSWORD;
  }
  if (!tokenOk) return res.status(401).json({ error: 'Yetkisiz' });
  const storedHash = process.env.BALPETEGI_HASH;
  const storedSalt = process.env.BALPETEGI_SALT;
  try {
    const saltBytes = Buffer.from(storedSalt, 'base64');
    const eskiHashBytes = crypto.pbkdf2Sync(eskiSifre, saltBytes, 310000, 64, 'sha512');
    if (eskiHashBytes.toString('base64') !== storedHash) {
      return res.status(401).json({ success: false, error: 'Eski balpeteği yanlış' });
    }
    const yeniSaltBytes = crypto.randomBytes(16);
    const yeniHashBytes = crypto.pbkdf2Sync(yeniSifre, yeniSaltBytes, 310000, 64, 'sha512');
    res.json({
      success: true,
      yeniSalt: yeniSaltBytes.toString('base64'),
      yeniHash: yeniHashBytes.toString('base64'),
      mesaj: 'Render Environment Variables güncelle: BALPETEGI_SALT ve BALPETEGI_HASH'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/ban-user', async (req, res) => {
  const { uid, banned, kozmikToken } = req.body;
  if (!uid || !(await tokenDogrula(kozmikToken))) return res.status(401).json({ error: 'Yetkisiz' });
  try {
    await db.collection('users').doc(uid).update({ banned: !!banned });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/shadow-ban', async (req, res) => {
  const { uid, shadowBanned, kozmikToken } = req.body;
  if (!uid || !(await tokenDogrula(kozmikToken))) return res.status(401).json({ error: 'Yetkisiz' });
  try {
    await db.collection('users').doc(uid).update({ shadowBanned: !!shadowBanned });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/temp-ban', async (req, res) => {
  const { uid, banExpiry, kozmikToken } = req.body;
  if (!uid || !(await tokenDogrula(kozmikToken))) return res.status(401).json({ error: 'Yetkisiz' });
  try {
    await db.collection('users').doc(uid).update({ banExpiry: banExpiry || 0, banned: false });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/set-badge', async (req, res) => {
  const { uid, badge, kozmikToken } = req.body;
  if (!uid || !(await tokenDogrula(kozmikToken))) return res.status(401).json({ error: 'Yetkisiz' });
  const validBadges = ['normal', 'vip', 'admin', 'founder'];
  if (!validBadges.includes(badge)) return res.status(400).json({ error: 'Geçersiz rozet' });
  try {
    await db.collection('users').doc(uid).update({ badge });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/delete-user', async (req, res) => {
  const { uid, username } = req.body;
  if (!uid || !username) return res.status(400).json({ error: 'uid ve username gerekli' });
  try {
    await admin.auth().deleteUser(uid);
    await db.collection('users').doc(uid).delete();
    await db.collection('usernames').doc(username.toLowerCase()).delete();
    await db.collection('friends').doc(username.toLowerCase()).delete();
    await db.collection('blocked').doc(username.toLowerCase()).delete();
    const frFrom = await db.collection('friendrequests').where('from', '==', username.toLowerCase()).get();
    const frTo = await db.collection('friendrequests').where('to', '==', username.toLowerCase()).get();
    const frBatch = db.batch();
    frFrom.docs.forEach(d => frBatch.delete(d.ref));
    frTo.docs.forEach(d => frBatch.delete(d.ref));
    await frBatch.commit();
    const chatsSnapshot = await db.collection('chats').get();
    for (const chatDoc of chatsSnapshot.docs) {
      if (chatDoc.id.includes(uid)) {
        const messages = await chatDoc.ref.collection('messages').get();
        const msgBatch = db.batch();
        messages.docs.forEach(m => msgBatch.delete(m.ref));
        await msgBatch.commit();
        await chatDoc.ref.delete();
      }
    }
    const allFriends = await db.collection('friends').get();
    const friendsBatch = db.batch();
    allFriends.docs.forEach(doc => {
      const friends = doc.data().friends || [];
      if (friends.includes(username.toLowerCase())) {
        friendsBatch.update(doc.ref, { friends: friends.filter(f => f !== username.toLowerCase()) });
      }
    });
    await friendsBatch.commit();
    const allBlocked = await db.collection('blocked').get();
    const blockedBatch = db.batch();
    allBlocked.docs.forEach(doc => {
      const blocked = doc.data().blocked || [];
      if (blocked.includes(username.toLowerCase())) {
        blockedBatch.update(doc.ref, { blocked: blocked.filter(b => b !== username.toLowerCase()) });
      }
    });
    await blockedBatch.commit();
    try { await cloudinary.api.delete_resources_by_prefix(`yogdzewa/statuses/${uid}`); } catch (_) {}
    await db.collection('pending_users').doc(uid).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function sendNotification(toToken, title, body) {
  try {
    await admin.messaging().send({
      token: toToken,
      notification: { title, body },
      android: { priority: 'high' }
    });
  } catch (error) {
    console.error('Bildirim hatası:', error);
  }
}

function startListening() {
  db.collectionGroup('messages')
    .where('notified', '==', false)
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const msg = change.doc.data();
          const toUid = msg.toUid;
          const fromUid = msg.fromUid;
          const fromUsername = (msg.from || 'Biri').toUpperCase();
          if (!toUid || toUid === fromUid) {
            await change.doc.ref.update({ notified: true });
            return;
          }
          const userDoc = await db.collection('users').doc(toUid).get();
          const fcmToken = userDoc.data()?.fcmToken;
          if (fcmToken) await sendNotification(fcmToken, fromUsername, 'Yeni mesajınız var');
          await change.doc.ref.update({ notified: true });
        }
      });
    });

  db.collection('friendrequests')
    .where('notified', '==', false)
    .where('status', '==', 'pending')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const req = change.doc.data();
          const toUsername = req.to;
          const fromUsername = (req.from || 'Biri').toUpperCase();
          if (!toUsername) return;
          const userDocs = await db.collection('users').where('username', '==', toUsername).get();
          const fcmToken = userDocs.docs[0]?.data()?.fcmToken;
          if (fcmToken) await sendNotification(fcmToken, 'Yeni Arkadaşlık İsteği', `${fromUsername} sana arkadaşlık isteği gönderdi`);
          await change.doc.ref.update({ notified: true });
        }
      });
    });

  db.collection('calls')
    .where('status', '==', 'calling')
    .onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const call = change.doc.data();
          const { calleeUid, callerUsername, callId } = call;
          if (!calleeUid || !callerUsername || !callId) return;
          const userDoc = await db.collection('users').doc(calleeUid).get();
          const fcmToken = userDoc.data()?.fcmToken;
          if (!fcmToken) return;
          try {
            await admin.messaging().send({
              token: fcmToken,
              data: {
                type: 'incoming_call',
                callerUsername: callerUsername,
                callId: callId
              },
              android: {
                priority: 'high',
                ttl: '30000'
              }
            });
          } catch (e) {
            console.error('Arama bildirimi hatası:', e);
          }
        }
      });
    });

  console.log('Firestore dinleniyor...');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor`);
  startListening();
  setInterval(() => {
    https.get('https://yogdzewa-server.onrender.com', (res) => {
      console.log('Keep-alive ping:', res.statusCode);
    }).on('error', (e) => {
      console.log('Keep-alive hata:', e.message);
    });
  }, 4 * 60 * 1000);
});
