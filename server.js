const admin = require('firebase-admin');
const express = require('express');
const https = require('https');

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

app.post('/delete-user', async (req, res) => {
  const { uid, username } = req.body;
  if (!uid || !username) return res.status(400).json({ error: 'uid ve username gerekli' });

  try {
    // 1. Firebase Auth'dan sil
    await admin.auth().deleteUser(uid);

    // 2. users koleksiyonu
    await db.collection('users').doc(uid).delete();

    // 3. usernames koleksiyonu
    await db.collection('usernames').doc(username.toLowerCase()).delete();

    // 4. friends koleksiyonu (kendi dokümanı)
    await db.collection('friends').doc(username.toLowerCase()).delete();

    // 5. blocked koleksiyonu (kendi dokümanı)
    await db.collection('blocked').doc(username.toLowerCase()).delete();

    // 6. friendrequests - kullanıcıyla ilgili tüm istekler
    const frFrom = await db.collection('friendrequests').where('from', '==', username.toLowerCase()).get();
    const frTo = await db.collection('friendrequests').where('to', '==', username.toLowerCase()).get();
    const frBatch = db.batch();
    frFrom.docs.forEach(d => frBatch.delete(d.ref));
    frTo.docs.forEach(d => frBatch.delete(d.ref));
    await frBatch.commit();

    // 7. chats - uid içeren tüm sohbetler + mesajları
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

    // ✅ 8. Diğer kullanıcıların friends listesinden sil
    const allFriends = await db.collection('friends').get();
    const friendsBatch = db.batch();
    allFriends.docs.forEach(doc => {
      const friends = doc.data().friends || [];
      if (friends.includes(username.toLowerCase())) {
        friendsBatch.update(doc.ref, {
          friends: friends.filter(f => f !== username.toLowerCase())
        });
      }
    });
    await friendsBatch.commit();

    // ✅ 9. Diğer kullanıcıların blocked listesinden sil
    const allBlocked = await db.collection('blocked').get();
    const blockedBatch = db.batch();
    allBlocked.docs.forEach(doc => {
      const blocked = doc.data().blocked || [];
      if (blocked.includes(username.toLowerCase())) {
        blockedBatch.update(doc.ref, {
          blocked: blocked.filter(b => b !== username.toLowerCase())
        });
      }
    });
    await blockedBatch.commit();

    // ✅ 10. pending_users temizle
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
