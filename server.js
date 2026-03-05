const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const clients = new Map();
const users = new Map(); // username -> { password, securityQuestion, securityAnswer }

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // Kullanici kayit
            if (data.type === 'register_user') {
                const { username, password, securityQuestion, securityAnswer } = data;
                if (users.has(username)) {
                    ws.send(JSON.stringify({ type: 'register_user_result', success: false, message: 'Bu kullanici adi zaten kullaniliyor' }));
                } else {
                    users.set(username, { password, securityQuestion, securityAnswer });
                    console.log(`Yeni kullanici kayit: ${username}`);
                    ws.send(JSON.stringify({ type: 'register_user_result', success: true }));
                }
            }

            // Kullanici giris
            else if (data.type === 'login_user') {
                const { username, password } = data;
                const user = users.get(username);
                if (user && user.password === password) {
                    userId = username;
                    clients.set(userId, ws);
                    console.log(`Giris yapti: ${userId}`);
                    ws.send(JSON.stringify({ type: 'login_user_result', success: true }));
                } else {
                    ws.send(JSON.stringify({ type: 'login_user_result', success: false, message: 'Kullanici adi veya sifre yanlis' }));
                }
            }

            // Kullanici ara
            else if (data.type === 'search_users') {
                const query = data.query.toLowerCase();
                const results = [];
                for (const [username] of users) {
                    if (username.toLowerCase().includes(query) && username !== userId) {
                        results.push(username);
                    }
                }
                ws.send(JSON.stringify({ type: 'search_results', results }));
            }

            // Baglanti kaydi
            else if (data.type === 'register') {
                userId = data.userId;
                clients.set(userId, ws);
                console.log(`Kullanici baglandi: ${userId}`);
                ws.send(JSON.stringify({ type: 'registered', userId }));
            }

            // Mesaj gonder
            else if (data.type === 'message') {
                const targetWs = clients.get(data.targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({
                        type: 'message',
                        fromId: userId,
                        content: data.content,
                        timestamp: Date.now()
                    }));
                }
            }

            // WebRTC
            else if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
                const targetWs = clients.get(data.targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({ ...data, fromId: userId }));
                }
            }

        } catch (e) {
            console.error('Hata:', e);
        }
    });

    ws.on('close', () => {
        if (userId) {
            clients.delete(userId);
            console.log(`Kullanici ayrildi: ${userId}`);
        }
    });
});

console.log('Yogdzewa sinyal sunucusu baslatildi!');