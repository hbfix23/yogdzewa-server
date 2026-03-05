const WebSocket = require('ws');
const { MongoClient } = require('mongodb');

const mongoUrl = 'mongodb+srv://hbfix23:Horizan01.@cluster0.u4q0qas.mongodb.net/?appName=Cluster0';
const dbName = 'yogdzewa';

let db;
let usersCol;
let friendRequestsCol;
let friendsCol;
let messagesCol;

MongoClient.connect(mongoUrl).then(client => {
    db = client.db(dbName);
    usersCol = db.collection('users');
    friendRequestsCol = db.collection('friendRequests');
    friendsCol = db.collection('friends');
    messagesCol = db.collection('messages');
    console.log('MongoDB baglandi!');
});

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const clients = new Map();

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register_user') {
                const { username, password, securityQuestion, securityAnswer } = data;
                const existing = await usersCol.findOne({ username });
                if (existing) {
                    ws.send(JSON.stringify({ type: 'register_user_result', success: false, message: 'Bu kullanici adi zaten kullaniliyor' }));
                } else {
                    await usersCol.insertOne({ username, password, securityQuestion, securityAnswer });
                    ws.send(JSON.stringify({ type: 'register_user_result', success: true }));
                }
            }

            else if (data.type === 'login_user') {
                const { username, password } = data;
                const user = await usersCol.findOne({ username, password });
                if (user) {
                    userId = username;
                    clients.set(userId, ws);
                    ws.send(JSON.stringify({ type: 'login_user_result', success: true }));
                    const pending = await friendRequestsCol.find({ targetId: username }).toArray();
                    if (pending.length > 0) {
                        ws.send(JSON.stringify({ type: 'pending_requests', requests: pending.map(r => r.fromId) }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'login_user_result', success: false, message: 'Kullanici adi veya sifre yanlis' }));
                }
            }

            else if (data.type === 'register') {
                userId = data.userId;
                clients.set(userId, ws);
                ws.send(JSON.stringify({ type: 'registered', userId }));
                const pending = await friendRequestsCol.find({ targetId: userId }).toArray();
                if (pending.length > 0) {
                    ws.send(JSON.stringify({ type: 'pending_requests', requests: pending.map(r => r.fromId) }));
                }
            }

            else if (data.type === 'get_pending_requests') {
                const pending = await friendRequestsCol.find({ targetId: userId }).toArray();
                ws.send(JSON.stringify({ type: 'pending_requests', requests: pending.map(r => r.fromId) }));
            }

            else if (data.type === 'search_users') {
                const query = data.query.toLowerCase();
                const results = await usersCol.find({ username: { $regex: query, $options: 'i' } }).toArray();
                const filtered = results.map(u => u.username).filter(u => u !== userId);
                ws.send(JSON.stringify({ type: 'search_results', results: filtered }));
            }

            else if (data.type === 'friend_request') {
                const targetId = data.targetId;
                const existing = await friendRequestsCol.findOne({ fromId: userId, targetId });
                if (!existing) {
                    await friendRequestsCol.insertOne({ fromId: userId, targetId });
                }
                const targetWs = clients.get(targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'friend_request', fromId: userId }));
                }
                ws.send(JSON.stringify({ type: 'friend_request_sent', success: true }));
            }

            else if (data.type === 'accept_friend') {
                const fromId = data.fromId;
                await friendsCol.updateOne({ userId }, { $addToSet: { friends: fromId } }, { upsert: true });
                await friendsCol.updateOne({ userId: fromId }, { $addToSet: { friends: userId } }, { upsert: true });
                await friendRequestsCol.deleteOne({ fromId, targetId: userId });
                const fromWs = clients.get(fromId);
                if (fromWs) {
                    fromWs.send(JSON.stringify({ type: 'friend_accepted', byId: userId }));
                }
                ws.send(JSON.stringify({ type: 'friend_accepted', byId: fromId }));
            }

            else if (data.type === 'reject_friend') {
                const fromId = data.fromId;
                await friendRequestsCol.deleteOne({ fromId, targetId: userId });
                ws.send(JSON.stringify({ type: 'friend_rejected', fromId }));
            }

            else if (data.type === 'get_friends') {
                const doc = await friendsCol.findOne({ userId });
                ws.send(JSON.stringify({ type: 'friends_list', friends: doc ? doc.friends : [] }));
            }

            else if (data.type === 'message') {
                const { targetId, content } = data;
                const timestamp = Date.now();
                await messagesCol.insertOne({ fromId: userId, targetId, content, timestamp });
                const targetWs = clients.get(targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'message', fromId: userId, content, timestamp }));
                }
            }

            else if (data.type === 'get_messages') {
                const { targetId } = data;
                const msgs = await messagesCol.find({
                    $or: [
                        { fromId: userId, targetId },
                        { fromId: targetId, targetId: userId }
                    ]
                }).sort({ timestamp: 1 }).toArray();
                ws.send(JSON.stringify({ type: 'messages_history', messages: msgs }));
            }

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
        if (userId) clients.delete(userId);
    });
});

console.log('Yogdzewa sinyal sunucusu baslatildi!');