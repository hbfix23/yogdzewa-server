const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const clients = new Map();

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register') {
                userId = data.userId;
                clients.set(userId, ws);
                console.log(`Kullanici baglandi: ${userId}`);
                ws.send(JSON.stringify({ type: 'registered', userId }));
            }

            else if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
                const targetWs = clients.get(data.targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({
                        ...data,
                        fromId: userId
                    }));
                }
            }

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