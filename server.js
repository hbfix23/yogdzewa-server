const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const clients = new Map();
const users = new Map();
const friendRequests = new Map();
const friends = new Map();

wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'register_user') {
                const { username, password, securityQuestion, securityAnswer } = data;
                if (users.has(username)) {
                    ws.send(JSON.stringify({ type: 'register_user_result', success: false, message: 'Bu kullanici adi zaten kullaniliyor' }));
                } else {
                    users.set(username, { password, securityQuestion, securityAnswer });
                    friendRequests.set(username, []);
                    friends.set(username, []);
                    ws.send(JSON.stringify({ type: 'register_user_result', success: true }));
                }
            }

            else if (data.type === 'login_user') {
                const { username, password } = data;
                const user = users.get(username);
                if (user && user.password === password) {
                    userId = username;
                    clients.set(userId, ws);
                    ws.send(JSON.stringify({ type: 'login_user_result', success: true }));
                    const pending = friendRequests.get(username) || [];
                    if (pending.length > 0) {
                        ws.send(JSON.stringify({ type: 'pending_requests', requests: pending }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'login_user_result', success: false, message: 'Kullanici adi veya sifre yanlis' }));
                }
            }

            else if (data.type === 'register') {
                userId = data.userId;
                clients.set(userId, ws);
                ws.send(JSON.stringify({ type: 'registered', userId }));
            }

            else if (data.type === 'get_pending_requests') {
                const pending = friendRequests.get(userId) || [];
                ws.send(JSON.stringify({ type: 'pending_requests', requests: pending }));
            }

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

            else if (data.type === 'friend_request') {
                const targetId = data.targetId;
                if (!friendRequests.has(targetId)) friendRequests.set(targetId, []);
                const requests = friendRequests.get(targetId);
                if (!requests.includes(userId)) {
                    requests.push(userId);
                    friendRequests.set(targetId, requests);
                }
                const targetWs = clients.get(targetId);
                if (targetWs) {
                    targetWs.send(JSON.stringify({ type: 'friend_request', fromId: userId }));
                }
                ws.send(JSON.stringify({ type: 'friend_request_sent', success: true }));
            }

            else if (data.type === 'accept_friend') {
                const fromId = data.fromId;
                if (!friends.has(userId)) friends.set(userId, []);
                if (!friends.has(fromId)) friends.set(fromId, []);
                const myFriends = friends.get(userId);
                if (!myFriends.includes(fromId)) myFriends.push(fromId);
                const theirFriends = friends.get(fromId);
                if (!theirFriends.includes(userId)) theirFriends.push(userId);
                const requests = friendRequests.get(userId) || [];
                friendRequests.set(userId, requests.filter(r => r !== fromId));
                const fromWs = clients.get(fromId);
                if (fromWs) {
                    fromWs.send(JSON.stringify({ type: 'friend_accepted', byId: userId }));
                }
                ws.send(JSON.stringify({ type: 'friend_accepted', byId: fromId }));
            }

            else if (data.type === 'reject_friend') {
                const fromId = data.fromId;
                const requests = friendRequests.get(userId) || [];
                friendRequests.set(userId, requests.filter(r => r !== fromId));
                ws.send(JSON.stringify({ type: 'friend_rejected', fromId }));
            }

            else if (data.type === 'get_friends') {
                const myFriends = friends.get(userId) || [];
                ws.send(JSON.stringify({ type: 'friends_list', friends: myFriends }));
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
        }
    });
});

console.log('Yogdzewa sinyal sunucusu baslatildi!');