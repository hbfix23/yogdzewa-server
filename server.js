const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const crypto = require('crypto');

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Yogdzewa bildirim sunucusu çalışıyor!');
});

// ✅ Kozmik Oda giriş doğrulama
app.post('/kozmik-auth', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Eksik bilgi' });

  const KOZMIK_USERNAME = process.env.KOZMIK_USERNAME;
  const KOZMIK_PASSWORD = process.env.KOZMIK_PASSWORD;

  if (!KOZMIK_USERNAME || !KOZMIK_PASSWORD) {
    return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });
  }

  if (username === KOZMIK_USERNAME && password === KOZMIK_PASSWORD) {
    console.log('Kozmik Oda girişi başarılı');
    res.json({ success: true });
  } else {
    console.log('Kozmik Oda yetkisiz giriş denemesi');
    res.status(401).json({ success: false, error: 'Yetkisiz erişim' });
  }
});

// ✅ Balpeteği doğrulama — PBKDF2 SHA-512, 310000 iterasyon
app.post('/balpetegi-auth', async (req, res) => {
  const { sifre } = req.body;
  if (!sifre) return res.status(400).json({ error: 'Şifre boş' });

  const storedHash = process.env.BALPETEGI_HASH;
  const storedSalt = process.env.BALPETEGI_SALT;

  if (!storedHash || !storedSalt) {
    return res.status(500).json({ error: 'Sunucu yapılandırma hatası' });
  }

  try {
    const saltBytes = Buffer.from(storedSalt, 'base64');
    const hashBytes = crypto.pbkdf2Sync(sifre, saltBytes, 310000, 64, 'sha512');
    const hashBase64 = hashBytes.toString('base64');

    if (hashBase64 === storedHash) {
      console.log('Balpeteği doğrulandı');
      res.json({ success: true });
    } else {
      console.log('Balpeteği yanlış');
      res.status(401).json({ success: false, error: 'Yanlış balpeteği' });
    }
  } catch (e) {
    console.error('Balpeteği doğrulama hatası:', e);
    res.status(500).json({ error: e.message });
  }
});

// ✅ Balpeteği değiştir — yeni hash döndürür, Render'a manuel eklersin
app.post('/balpetegi-degistir', async (req, res) => {
  const { eskiSifre, yeniSifre, kozmikToken } = req.body;
  if (!eskiSifre || !yeniSifre || !kozmikToken) return res.status(400).json({ error: 'Eksik bilgi' });

  if (kozmikToken !== process.env.KOZMIK_PASSWORD) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  const storedHash = process.env.BALPETEGI_HASH;
  const storedSalt = process.env.BALPETEGI_SALT;

  try {
    const saltBytes = Buffer.from(storedSalt, 'base64');
    const eskiHashBytes = crypto.pbkdf2Sync(eskiSifre, saltBytes, 310000, 64, 'sha512');
    const eskiHashBase64 = eskiHashBytes.toString('base64');

    if (eskiHashBase64 !== storedHash) {
      return res.status(401).json({ success: false, error: 'Eski balpeteği yanlış' });
    }

    const yeniSaltBytes = crypto.randomBytes(16);
    const yeniHashBytes = crypto.pbkdf2Sync(yeniSifre, yeniSaltBytes, 310000, 64, 'sha512');
    const yeniSaltBase64 = yeniSaltBytes.toString('base64');
    const yeniHashBase64 = yeniHashBytes.toString('base64');

    res.json({
      success: true,
      yeniSalt: yeniSaltBase64,
      yeniHash: yeniHashBase64
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    await db.collection('pending_users').doc(uid).delete();

    console.log(`Hesap silindi: ${uid} / ${username}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Hesap silme hatası:', error);
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
    console.log('Bildirim gönderildi:', title);
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
