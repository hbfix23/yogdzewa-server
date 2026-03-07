const admin = require('firebase-admin');
const express = require('express');
const https = require('https');
const nodemailer = require('nodemailer');

const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(express.json());

// OTP bellekte sakla (uid -> {otp, expiry})
const otpStore = new Map();

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.get('/', (req, res) => {
  res.send('Yogdzewa bildirim sunucusu çalışıyor!');
});

// OTP gönder
app.post('/send-otp', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ success: false, message: 'uid gerekli' });

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'Kullanici bulunamadi' });

    const email = userDoc.data().email;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = Date.now() + 10 * 60 * 1000; // 10 dakika

    otpStore.set(uid, { otp, expiry });

    await transporter.sendMail({
      from: `"Yogdzewa" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Şifre Sıfırlama Kodu',
      html: `
        <div style="font-family: Arial; max-width: 400px; margin: 0 auto; padding: 20px; background: #1a0025; color: white; border-radius: 12px;">
          <h2 style="color: #cc0000;">Yogdzewa</h2>
          <p>Şifre sıfırlama kodunuz:</p>
          <h1 style="letter-spacing: 8px; color: #ff4444; text-align: center;">${otp}</h1>
          <p style="opacity: 0.7; font-size: 13px;">Bu kod 10 dakika geçerlidir. Kodu kimseyle paylaşmayın.</p>
        </div>
      `
    });

    console.log('OTP gönderildi:', email);
    res.json({ success: true });
  } catch (error) {
    console.error('OTP hatası:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// OTP doğrula
app.post('/verify-otp', (req, res) => {
  try {
    const { uid, otp } = req.body;
    if (!uid || !otp) return res.status(400).json({ success: false, message: 'uid ve otp gerekli' });

    const stored = otpStore.get(uid);
    if (!stored) return res.json({ success: false, message: 'OTP bulunamadi veya suresi doldu' });
    if (Date.now() > stored.expiry) {
      otpStore.delete(uid);
      return res.json({ success: false, message: 'OTP suresi doldu' });
    }
    if (stored.otp !== otp) return res.json({ success: false, message: 'OTP yanlis' });

    otpStore.delete(uid);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Şifre sıfırla (Admin SDK ile)
app.post('/reset-password', async (req, res) => {
  try {
    const { uid, newPassword } = req.body;
    if (!uid || !newPassword) return res.status(400).json({ success: false, message: 'uid ve newPassword gerekli' });
    if (newPassword.length < 6) return res.json({ success: false, message: 'Sifre en az 6 karakter olmali' });

    await admin.auth().updateUser(uid, { password: newPassword });
    console.log('Şifre sıfırlandı:', uid);
    res.json({ success: true });
  } catch (error) {
    console.error('Şifre sıfırlama hatası:', error);
    res.status(500).json({ success: false, message: error.message });
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
